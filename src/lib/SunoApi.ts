import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import yn from 'yn';
import { isPage, sleep, waitForRequests } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { Solver } from '@2captcha/captcha-solver';
import { paramsCoordinates } from '@2captcha/captcha-solver/dist/structs/2captcha';
import { BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import { promises as fs } from 'fs';
import path from 'node:path';

// sunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const logger = pino();
export const DEFAULT_MODEL = 'chirp-auk-turbo';

export interface AudioInfo {
  id: string;
  title?: string;
  image_url?: string;
  lyric?: string;
  audio_url?: string;
  video_url?: string;
  created_at: string;
  model_name: string;
  gpt_description_prompt?: string;
  prompt?: string;
  status: string;
  type?: string;
  tags?: string;
  negative_tags?: string;
  duration?: string;
  error_message?: string;
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any;
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{
      clip: any;
    }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

class SunoApi {
  private static BASE_URL: string = 'https://studio-api.prod.suno.com';
  private static CLERK_BASE_URL: string = 'https://auth.suno.com';
  private static CLERK_VERSION = '5.117.0';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
  private ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
  private cursor?: Cursor;

  constructor(cookies: string) {
    this.userAgent = new UserAgent(/Macintosh/).random().toString();
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();

    this.client = axios.create({
      withCredentials: true,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `"${this.deviceId}"`,
        'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
        'X-Requested-With': 'com.suno.android',
        'sec-ch-ua': '"Chromium";v="130", "Android WebView";v="130", "Not?A_Brand";v="99"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'User-Agent': this.userAgent
      }
    });

    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization) {
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      }

      const cookiesArray = Object.entries(this.cookies)
        .filter(([key, value]) => !!key && typeof value === 'string' && value.trim() !== '')
        .map(([key, value]) => cookie.serialize(key, value as string));

      config.headers.Cookie = cookiesArray.join('; ');
      return config;
    });

    this.client.interceptors.response.use(resp => {
      const setCookieHeader = resp.headers['set-cookie'];
      if (Array.isArray(setCookieHeader)) {
        const newCookies = cookie.parse(setCookieHeader.join('; '));
        for (const [key, value] of Object.entries(newCookies)) {
          this.cookies[key] = value;
        }
      }
      return resp;
    });
  }

  public async init(): Promise<SunoApi> {
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  private async getAuthToken() {
    logger.info('Getting the session ID');

    const getSessionUrl =
      `${SunoApi.CLERK_BASE_URL}/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;

    const sessionResponse = await this.client.get(getSessionUrl, {
      headers: { Authorization: this.cookies.__client }
    });

    if (!sessionResponse?.data?.response?.last_active_session_id) {
      throw new Error('Failed to get session id, you may need to update the SUNO_COOKIE');
    }

    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }

    const renewUrl =
      `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=${SunoApi.CLERK_VERSION}`;

    logger.info('KeepAlive...\n');

    const renewResponse = await this.client.post(
      renewUrl,
      {},
      { headers: { Authorization: this.cookies.__client } }
    );

    if (isWait) {
      await sleep(1, 2);
    }

    const newToken = renewResponse.data.jwt;
    this.currentToken = newToken;
  }

  private async getSessionToken() {
    const tokenResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/user/create_session_id/`,
      {
        session_properties: JSON.stringify({ deviceId: this.deviceId }),
        session_type: 1
      }
    );
    return tokenResponse.data.session_id;
  }

  private async captchaRequired(): Promise<boolean> {
    const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
      ctype: 'generation'
    });
    logger.info(resp.data);
    return resp.data.required;
  }

  private async click(target: Locator | Page, position?: { x: number; y: number }): Promise<void> {
    if (this.ghostCursorEnabled) {
      let pos: any = isPage(target) ? { x: 0, y: 0 } : await target.boundingBox();
      if (position) {
        pos = {
          ...pos,
          x: pos.x + position.x,
          y: pos.y + position.y,
          width: null,
          height: null,
        };
      }
      return this.cursor?.actions.click({
        target: pos
      });
    } else {
      if (isPage(target)) {
        return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
      } else {
        return target.click({ force: true, position });
      }
    }
  }

  private getBrowserType() {
    const browser = process.env.BROWSER?.toLowerCase();
    switch (browser) {
      case 'firefox':
        return firefox;
      default:
        return chromium;
    }
  }

  private async launchBrowser(): Promise<BrowserContext> {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
      '--disable-features=IsolateOrigins',
      '--disable-extensions',
      '--disable-infobars'
    ];

    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false })) {
      args.push(
        '--enable-unsafe-swiftshader',
        '--disable-gpu',
        '--disable-setuid-sandbox'
      );
    }

    const browser = await this.getBrowserType().launch({
      args,
      headless: yn(process.env.BROWSER_HEADLESS, { default: true })
    });

    const context = await browser.newContext({
      userAgent: this.userAgent,
      locale: process.env.BROWSER_LOCALE,
      viewport: null
    });

    const cookiesToAdd: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      sameSite: 'Lax';
    }> = [];

    // 先不要手动塞 __session，避免 currentToken 当 cookie 导致 Invalid cookie fields
    for (const [key, rawValue] of Object.entries(this.cookies)) {
      if (!key) continue;
      if (typeof rawValue !== 'string') continue;

      const value = rawValue.trim();
      if (!value) continue;
      if (value === 'undefined' || value === 'null') continue;

      cookiesToAdd.push({
        name: key,
        value,
        domain: 'suno.com',
        path: '/',
        sameSite: 'Lax'
      });
    }

    for (const ck of cookiesToAdd) {
      try {
        await context.addCookies([ck]);
        logger.info(`Added cookie: ${ck.name}`);
      } catch (err) {
        logger.error({ cookie: ck }, `Failed to add cookie: ${ck.name}`);
        throw err;
      }
    }

    return context;
  }

  public async getCaptcha(): Promise<string | null> {
    const required = await this.captchaRequired();
    if (!required) {
      return null;
    }

    logger.info('CAPTCHA required. Launching browser...');

    let browser: BrowserContext | null = null;

    try {
      browser = await this.launchBrowser();
      const page = await browser.newPage();

      await page.goto('https://suno.com/create', {
        referer: 'https://www.google.com/',
        waitUntil: 'domcontentloaded',
        timeout: 0
      });

      logger.info('Waiting for Suno interface to load');
      await page.waitForResponse('**/api/project/**\\?**', { timeout: 60000 });

      if (this.ghostCursorEnabled) {
        this.cursor = await createCursor(page);
      }

      logger.info('Triggering the CAPTCHA');

      try {
        await page.getByLabel('Close').click({ timeout: 2000 });
      } catch (e) {}

      const textarea = page.locator('.custom-textarea');
      await this.click(textarea);
      await textarea.pressSequentially('Lorem ipsum', { delay: 80 });

      const button = page.locator('button[aria-label="Create"]').locator('div.flex');
      this.click(button);

      const controller = new AbortController();

      new Promise<void>(async (resolve, reject) => {
        const frame = page.frameLocator('iframe[title*="hCaptcha"]');
        const challenge = frame.locator('.challenge-container');

        try {
          let wait = true;
          while (true) {
            if (wait) {
              await waitForRequests(page, controller.signal);
            }

            const drag = (await challenge.locator('.prompt-text').first().innerText())
              .toLowerCase()
              .includes('drag');

            let captcha: any;
            for (let j = 0; j < 3; j++) {
              try {
                logger.info('Sending the CAPTCHA to 2Captcha');
                const payload: paramsCoordinates = {
                  body: (await challenge.screenshot({ timeout: 5000 })).toString('base64'),
                  lang: process.env.BROWSER_LOCALE
                };

                if (drag) {
                  payload.textinstructions =
                    'CLICK on the shapes at their edge or center as shown above—please be precise!';
                  payload.imginstructions = (
                    await fs.readFile(path.join(process.cwd(), 'public', 'drag-instructions.jpg'))
                  ).toString('base64');
                }

                captcha = await this.solver.coordinates(payload);
                break;
              } catch (err: any) {
                logger.info(err.message);
                if (j !== 2) {
                  logger.info('Retrying...');
                } else {
                  throw err;
                }
              }
            }

            if (drag) {
              const challengeBox = await challenge.boundingBox();
              if (challengeBox == null) {
                throw new Error('.challenge-container boundingBox is null!');
              }

              if (captcha.data.length % 2) {
                logger.info(
                  'Solution does not have even amount of points required for dragging. Requesting new solution...'
                );
                this.solver.badReport(captcha.id);
                wait = false;
                continue;
              }

              for (let i = 0; i < captcha.data.length; i += 2) {
                const data1 = captcha.data[i];
                const data2 = captcha.data[i + 1];
                logger.info(JSON.stringify(data1) + JSON.stringify(data2));
                await page.mouse.move(challengeBox.x + +data1.x, challengeBox.y + +data1.y);
                await page.mouse.down();
                await sleep(1.1);
                await page.mouse.move(challengeBox.x + +data2.x, challengeBox.y + +data2.y, {
                  steps: 30
                });
                await page.mouse.up();
              }
              wait = true;
            } else {
              for (const data of captcha.data) {
                logger.info(data);
                await this.click(challenge, { x: +data.x, y: +data.y });
              }
            }

            this.click(frame.locator('.button-submit')).catch((e) => {
              if (e.message.includes('viewport')) {
                this.click(button);
              } else {
                throw e;
              }
            });
          }
        } catch (e: any) {
          if (e.message.includes('been closed') || e.message === 'AbortError') {
            resolve();
          } else {
            reject(e);
          }
        }
      }).catch((e) => {
        browser?.browser()?.close();
        throw e;
      });

      return await new Promise((resolve, reject) => {
        page.route('**/api/generate/v2/**', async (route: any) => {
          try {
            logger.info('hCaptcha token received. Closing browser');
            route.abort();
            browser?.browser()?.close();
            controller.abort();

            const request = route.request();
            const authHeader = request.headers().authorization;
            if (authHeader?.startsWith('Bearer ')) {
              this.currentToken = authHeader.replace('Bearer ', '');
            }

            resolve(request.postDataJSON().token);
          } catch (err) {
            reject(err);
          }
        });
      });
    } catch (error) {
      logger.error(error, 'getCaptcha failed');
      throw error;
    }
  }

  private async getTurnstile() {
    return this.client.post(
      `https://clerk.suno.com/v1/client?__clerk_api_version=2021-02-05&_clerk_js_version=${SunoApi.CLERK_VERSION}&_method=PATCH`,
      { captcha_error: '300030,300030,300030' },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } }
    );
  }

  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();

    const audios = await this.generateSongs(
      prompt,
      false,
      undefined,
      undefined,
      make_instrumental,
      model,
      wait_audio
    );

    const costTime = Date.now() - startTime;
    logger.info('Generate Response:\n' + JSON.stringify(audios, null, 2));
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const payload: any = { clip_id };

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      payload,
      { timeout: 10000 }
    );

    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }

    return response.data;
  }

  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string
  ): Promise<AudioInfo[]> {
    const startTime = Date.now();

    const audios = await this.generateSongs(
      prompt,
      true,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags
    );

    const costTime = Date.now() - startTime;
    logger.info('Custom Generate Response:\n' + JSON.stringify(audios, null, 2));
    logger.info('Cost time: ' + costTime);
    return audios;
  }

  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    task?: string,
    continue_clip_id?: string,
    continue_at?: number
  ): Promise<AudioInfo[]> {
    await this.keepAlive();

    const captchaToken = await this.getCaptcha();

    const payload: any = {
      make_instrumental,
      prompt: '',
      generation_type: 'TEXT',
      continue_at,
      continue_clip_id,
      task,
      token: captchaToken
    };

    if (model) {
      payload.mv = model;
    } else if (DEFAULT_MODEL) {
      payload.mv = DEFAULT_MODEL;
    }

    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.prompt = prompt;
    } else {
      payload.gpt_description_prompt = prompt;
    }

    logger.info(
      'generateSongs payload:\n' +
        JSON.stringify(
          {
            prompt,
            isCustom,
            tags,
            title,
            make_instrumental,
            wait_audio,
            negative_tags,
            payload: {
              ...payload,
              token: payload.token ? '[captcha-token-present]' : null
            }
          },
          null,
          2
        )
    );

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/v2/`,
      payload,
      { timeout: 10000 }
    );

    if (response.status !== 200) {
      throw new Error('Error response:' + response.statusText);
    }

    const songIds = response.data.clips.map((audio: any) => audio.id);

    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);

      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          (audio) => audio.status === 'streaming' || audio.status === 'complete'
        );
        const allError = response.every((audio) => audio.status === 'error');

        if (allCompleted || allError) {
          return response;
        }

        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }

      return lastResponse;
    } else {
      return response.data.clips.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration
      }));
    }
  }

  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);

    const generateResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/lyrics/`,
      { prompt }
    );
    const generateId = generateResponse.data.id;

    let lyricsResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
    );

    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2);
      lyricsResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
      );
    }

    return lyricsResponse.data;
  }

  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean
  ): Promise<AudioInfo[]> {
    return this.generateSongs(
      prompt,
      true,
      tags,
      title,
      false,
      model,
      wait_audio,
      negative_tags,
      'extend',
      audioId,
      continueAt
    );
  }

  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    await this.keepAlive(false);

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/edit/stems/${song_id}`,
      {}
    );

    console.log('generateStems response:\n', response?.data);

    return response.data.clips.map((clip: any) => ({
      id: clip.id,
      status: clip.status,
      created_at: clip.created_at,
      title: clip.title,
      stem_from_id: clip.metadata.stem_from_id,
      duration: clip.metadata.duration
    }));
  }

  public async getLyricAlignment(song_id: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`
    );

    console.log(`getLyricAlignment ~ response:`, response.data);

    return response.data?.aligned_words.map((transcribedWord: any) => ({
      word: transcribedWord.word,
      start_s: transcribedWord.start_s,
      end_s: transcribedWord.end_s,
      success: transcribedWord.success,
      p_align: transcribedWord.p_align
    }));
  }

  private parseLyrics(prompt: string): string {
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');
    return lines.join('\n');
  }

  public async get(songIds?: string[], page?: string | null): Promise<AudioInfo[]> {
    await this.keepAlive(false);

    const url = new URL(`${SunoApi.BASE_URL}/api/feed/v2`);
    if (songIds) {
      url.searchParams.append('ids', songIds.join(','));
    }
    if (page) {
      url.searchParams.append('page', page);
    }

    logger.info('Get audio status: ' + url.href);

    const response = await this.client.get(url.href, {
      timeout: 10000
    });

    const audios = response.data.clips;

    return audios.map((audio: any) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt ? this.parseLyrics(audio.metadata.prompt) : '',
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata.gpt_description_prompt,
      prompt: audio.metadata.prompt,
      type: audio.metadata.type,
      tags: audio.metadata.tags,
      duration: audio.metadata.duration,
      error_message: audio.metadata.error_message
    }));
  }

  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/clip/${clipId}`);
    return response.data;
  }

  public async get_credits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/billing/info/`);
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage
    };
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    await this.keepAlive(false);

    const url =
      `${SunoApi.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`;

    logger.info(`Fetching persona data: ${url}`);

    const response = await this.client.get(url, {
      timeout: 10000
    });

    if (response.status !== 200) {
      throw new Error('Error response: ' + response.statusText);
    }

    return response.data;
  }
}

export const sunoApi = async (cookie?: string) => {
  const resolvedCookie =
    cookie && cookie.includes('__client') ? cookie : process.env.SUNO_COOKIE;

  if (!resolvedCookie) {
    logger.info(
      'No cookie provided! Aborting...\nPlease provide a cookie either in the .env file or in the Cookie header of your request.'
    );
    throw new Error(
      'Please provide a cookie either in the .env file or in the Cookie header of your request.'
    );
  }

  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance) return cachedInstance;

  const instance = await new SunoApi(resolvedCookie).init();
  cache.set(resolvedCookie, instance);

  return instance;
};
