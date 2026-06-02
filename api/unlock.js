import puppeteer from 'puppeteer-core';
import axios from 'axios';
import * as cheerio from 'cheerio';

// ==================== KONFIGURASI ====================
const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || null;   // isi jika pakai 2captcha.com
const USE_STEALTH = process.env.USE_STEALTH === 'true';        // set true jika install puppeteer-extra

// ==================== MAIN HANDLER ====================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url, password = null, manualCaptchaSolved = false, useApiSolver = false } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let browser = null;
  let page = null;
  const allDiscoveredUrls = new Set();
  const mp4Links = new Set();
  const redirectChain = [];
  let captchaDetected = false;
  let captchaType = null;
  let passwordRequired = false;
  let finalMainLink = null;

  try {
    // Launch browser dengan anti-detection
    const launchOptions = {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled'
      ],
      headless: 'new'
    };

    if (USE_STEALTH) {
      const puppeteerExtra = await import('puppeteer-extra');
      const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
      puppeteerExtra.default.use(StealthPlugin());
      browser = await puppeteerExtra.default.launch(launchOptions);
    } else {
      browser = await puppeteer.launch(launchOptions);
    }

    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://google.com'
    });

    // Hilangkan tanda webdriver
    await page.evaluateOnNewDocument(() => {
      delete navigator.__proto__.webdriver;
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Monitor responses
    page.on('response', async (response) => {
      const responseUrl = response.url();
      allDiscoveredUrls.add(responseUrl);
      if (responseUrl.match(/\.(mp4|m3u8|webm|mkv|avi|mov)(\?.*)?$/i)) {
        mp4Links.add(responseUrl);
      }
      if (response.status() >= 300 && response.status() < 400) {
        const location = response.headers()['location'];
        if (location) redirectChain.push({ from: responseUrl, to: location });
      }
    });

    console.log(`🔍 Scanning: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // ========== 1. DETEKSI CAPTCHA & PASSWORD ==========
    const captchaResult = await detectCaptcha(page);
    captchaDetected = captchaResult.detected;
    captchaType = captchaResult.type;
    passwordRequired = await detectPasswordProtection(page);

    // ========== 2. HANDLE PASSWORD ==========
    if (passwordRequired && password) {
      const ok = await handlePassword(page, password);
      if (!ok) {
        await browser.close();
        return res.status(200).json({ success: false, password_required: true, message: 'Password salah atau tidak valid.' });
      }
      await page.waitForTimeout(3000);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
    } else if (passwordRequired && !password) {
      await browser.close();
      return res.status(200).json({ success: false, password_required: true, message: 'Link ini membutuhkan password.' });
    }

    // ========== 3. HANDLE CAPTCHA (OTOMATIS/MANUAL) ==========
    let captchaResolved = false;
    if (captchaDetected && !manualCaptchaSolved) {
      captchaResolved = await autoSolveCaptcha(page, captchaType, useApiSolver);
      if (!captchaResolved) {
        await browser.close();
        return res.status(200).json({
          success: false,
          captcha_detected: true,
          captcha_type: captchaType,
          message: `Captcha (${captchaType}) tidak bisa dipecahkan otomatis. Silakan selesaikan secara manual di browser, lalu scan ulang dengan mencentang "Saya sudah selesaikan captcha".`
        });
      }
    } else if (captchaDetected && manualCaptchaSolved) {
      captchaResolved = true;
      console.log('User menyatakan captcha sudah di-solve manual');
      await page.waitForTimeout(2000);
    }

    // ========== 4. KLIK SEMUA TOMBOL UNLOCK / LANJUT ==========
    if (!captchaDetected || captchaResolved) {
      await aggressiveClickAllButtons(page);
    }

    // ========== 5. TUNGGU KONTEN UTAMA ==========
    await waitForMainContent(page);

    // ========== 6. EKSTRAK SEMUA LINK & VIDEO ==========
    const pageContent = await page.content();
    const $ = cheerio.load(pageContent);
    const finalUrl = page.url();

    extractAllLinks($, page, allDiscoveredUrls, mp4Links);
    extractLinksFromScripts($, allDiscoveredUrls, mp4Links);
    extractMetaRefreshLinks($, page, allDiscoveredUrls);
    extractVideoSources($, page, mp4Links);

    finalMainLink = await extractBestLink(page, $, mp4Links);
    if (!finalMainLink && redirectChain.length) {
      finalMainLink = redirectChain[redirectChain.length - 1].to;
    }
    if (!finalMainLink) finalMainLink = finalUrl;

    await browser.close();

    return res.status(200).json({
      success: true,
      original_url: url,
      final_url: finalUrl,
      main_content_link: finalMainLink,
      redirect_chain: redirectChain,
      all_discovered_urls: Array.from(allDiscoveredUrls).slice(0, 60),
      mp4_links: Array.from(mp4Links),
      total_mp4_found: mp4Links.size,
      captcha_detected: captchaDetected,
      captcha_type: captchaType,
      password_required: passwordRequired,
      message: mp4Links.size > 0 ? `✅ Ditemukan ${mp4Links.size} video MP4. Link utama: ${finalMainLink}` : `✅ Link berhasil diproses. Link utama: ${finalMainLink}`
    });

  } catch (error) {
    console.error('Error:', error);
    if (browser) await browser.close();
    return res.status(500).json({
      success: false,
      error: error.message,
      captcha_detected: captchaDetected,
      password_required: passwordRequired,
      partial_mp4_links: Array.from(mp4Links),
      message: 'Terjadi kesalahan saat memproses link.'
    });
  }
}

// ==================== FUNGSI DETEKSI ====================
async function detectCaptcha(page) {
  const content = await page.content();
  const url = page.url();
  const patterns = {
    recaptcha: /(recaptcha|g-recaptcha|google\.com\/recaptcha)/i,
    hcaptcha: /h-captcha/i,
    turnstile: /turnstile|cloudflare\.com\/cdn-cgi\/challenge/i,
    text_captcha: /(captcha code|enter captcha|verification code|type the text)/i,
    math_captcha: /(what is|solve this|math question|calculate|answer:)/i,
    slider: /slide to verify|drag the slider/i
  };
  for (const [type, regex] of Object.entries(patterns)) {
    if (regex.test(content) || regex.test(url)) {
      const frames = page.frames();
      for (const frame of frames) {
        if (regex.test(frame.url())) return { detected: true, type };
      }
      const sel = type === 'recaptcha' ? '.g-recaptcha' : type === 'hcaptcha' ? '.h-captcha' : null;
      if (sel && await page.$(sel).catch(() => null)) return { detected: true, type };
      return { detected: true, type };
    }
  }
  if (await page.$('.captcha, #captcha, [class*="captcha"]').catch(() => null)) {
    return { detected: true, type: 'generic_captcha' };
  }
  return { detected: false, type: null };
}

async function detectPasswordProtection(page) {
  if (!await page.$('input[type="password"]')) return false;
  const text = await page.content();
  return /password|enter password|protected page/i.test(text);
}

// ==================== HANDLE PASSWORD ====================
async function handlePassword(page, password) {
  try {
    const pwd = await page.$('input[type="password"]');
    if (!pwd) return false;
    await pwd.type(password);
    const submit = await page.$('input[type="submit"], button[type="submit"], button:has-text("Submit"), button:has-text("Enter"), button:has-text("Unlock")');
    if (submit) await submit.click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const error = await page.evaluate(() => {
      const err = document.querySelector('.error, .alert, [class*="error"]');
      return err ? err.innerText : '';
    });
    return !error.toLowerCase().includes('wrong') && !error.toLowerCase().includes('incorrect');
  } catch (e) {
    return false;
  }
}

// ==================== AUTO SOLVE CAPTCHA ====================
async function autoSolveCaptcha(page, type, useApiSolver) {
  if (type === 'math_captcha') return await solveMathCaptcha(page);
  if (type === 'text_captcha') return await solveTextCaptcha(page);
  if ((type === 'recaptcha' || type === 'hcaptcha') && useApiSolver && CAPTCHA_API_KEY) {
    return await solveWith2Captcha(page, type);
  }
  return false;
}

async function solveMathCaptcha(page) {
  try {
    const mathText = await page.evaluate(() => {
      const selectors = ['.captcha', '#captcha', '.math-captcha', '[class*="captcha"]', 'span', 'div', 'p'];
      for (let sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (let el of els) {
          const text = el.innerText;
          if (text && /[\d\+\-\*\/\=]\s*\?/.test(text)) return text;
        }
      }
      return null;
    });
    if (!mathText) return false;
    const match = mathText.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)\s*=\s*\?/i);
    if (!match) return false;
    const a = parseInt(match[1]), b = parseInt(match[3]), op = match[2];
    let result;
    if (op === '+') result = a + b;
    else if (op === '-') result = a - b;
    else if (op === '*') result = a * b;
    else if (op === '/') result = a / b;
    else return false;
    const input = await page.$('input[type="text"], input[type="number"]');
    if (!input) return false;
    await input.type(result.toString());
    const submit = await page.$('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Verify")');
    if (submit) await submit.click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    return true;
  } catch (e) {
    return false;
  }
}

async function solveTextCaptcha(page) {
  // Text captcha tidak bisa di-solve otomatis tanpa OCR
  return false;
}

async function solveWith2Captcha(page, type) {
  // Integrasi dengan 2Captcha (perlu implementasi sesuai API)
  // Placeholder: return false agar manual
  return false;
}

// ==================== AGGRESSIVE CLICK BUTTONS ====================
async function aggressiveClickAllButtons(page) {
  const selectors = [
    'a:has-text("Unlock")', 'a:has-text("Continue")', 'a:has-text("Get Link")',
    'a:has-text("Click here")', 'a:has-text("Free Access")', 'a:has-text("Watch Video")',
    'a:has-text("Download")', 'a:has-text("Proceed")', 'a:has-text("Next")',
    'button:has-text("Unlock")', 'button:has-text("Continue")', 'button:has-text("Get Link")',
    'button:has-text("Verify")', 'button:has-text("I am human")', 'button:has-text("Submit")',
    'button:has-text("Next")', 'button:has-text("Free Access")', 'button:has-text("Watch")',
    '.btn-unlock', '#unlock-btn', '.get-link', '.continue-btn', '.next-button',
    'a[href*="/go/"]', 'a[href*="/get/"]', 'input[value="Unlock"]', 'input[value="Continue"]'
  ];
  let clicked = true;
  let iter = 0;
  while (clicked && iter < 10) {
    clicked = false;
    for (const sel of selectors) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          console.log(`Clicked: ${sel}`);
          clicked = true;
          await page.waitForTimeout(1500);
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => null);
          break;
        }
      } catch (e) {}
    }
    iter++;
  }
  // Klik semua tombol yang mengandung kata kunci
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));
    const keywords = ['unlock', 'continue', 'get link', 'proceed', 'next', 'verify', 'free access', 'watch', 'download'];
    for (const btn of btns) {
      const txt = (btn.innerText || btn.value || '').toLowerCase();
      if (keywords.some(k => txt.includes(k))) btn.click();
    }
  });
  await page.waitForTimeout(2000);
}

// ==================== WAIT FOR MAIN CONTENT ====================
async function waitForMainContent(page) {
  await page.waitForFunction(
    () => {
      const hasVideo = document.querySelector('video, iframe[src*=".mp4"], source');
      const hasLinks = document.querySelectorAll('a[href*=".mp4"], a[href*="/d/"], a[href*="/download"]').length > 0;
      const hasFinal = /(\/v\/|\/watch|\/embed|\/d\/)/.test(window.location.href);
      return hasVideo || hasLinks || hasFinal || document.querySelector('.player-container, #video-player');
    },
    { timeout: 45000, polling: 800 }
  ).catch(() => console.log('Timeout menunggu konten, tetap ekstrak...'));
}

// ==================== EKSTRAKSI LINK ====================
function extractAllLinks($, page, allDiscoveredUrls, mp4Links) {
  $('a[href]').each((i, el) => {
    let href = $(el).attr('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      try {
        const abs = new URL(href, page.url()).href;
        allDiscoveredUrls.add(abs);
        if (/\.(mp4|m3u8|webm|mkv|avi|mov)(\?.*)?$/i.test(abs)) mp4Links.add(abs);
      } catch(e) {}
    }
  });
  $('iframe[src], frame[src]').each((i, el) => {
    let src = $(el).attr('src');
    if (src) try { allDiscoveredUrls.add(new URL(src, page.url()).href); } catch(e) {}
  });
}

function extractLinksFromScripts($, allDiscoveredUrls, mp4Links) {
  const scripts = $('script').map((i, el) => $(el).html()).get();
  const urlRegex = /(https?:\/\/[^\s"'<>(){}|\\^`[\]]+)/gi;
  scripts.forEach(script => {
    if (script) {
      (script.match(urlRegex) || []).forEach(url => {
        try {
          const clean = url.replace(/['"]/g, '');
          allDiscoveredUrls.add(clean);
          if (/\.(mp4|m3u8|webm|mkv)(\?.*)?$/i.test(clean)) mp4Links.add(clean);
        } catch(e) {}
      });
    }
  });
}

function extractMetaRefreshLinks($, page, allDiscoveredUrls) {
  const meta = $('meta[http-equiv="refresh"]').attr('content');
  if (meta && meta.includes('url=')) {
    let hidden = decodeURIComponent(meta.split('url=')[1]);
    try { allDiscoveredUrls.add(new URL(hidden, page.url()).href); } catch(e) {}
  }
}

function extractVideoSources($, page, mp4Links) {
  $('video source, video').each((i, el) => {
    let src = $(el).attr('src') || $(el).attr('data-src');
    if (src) try { mp4Links.add(new URL(src, page.url()).href); } catch(e) {}
  });
  $('[data-video], [data-mp4], [data-src*="mp4"]').each((i, el) => {
    let ds = $(el).attr('data-video') || $(el).attr('data-mp4') || $(el).attr('data-src');
    if (ds && ds.includes('mp4')) try { mp4Links.add(new URL(ds, page.url()).href); } catch(e) {}
  });
}

async function extractBestLink(page, $, mp4Links) {
  if (mp4Links.size) return Array.from(mp4Links)[0];
  const downloadSelectors = [
    'a[href*="/d/"]', 'a[href*="/download"]', 'a[href*="/get/"]',
    'a:has-text("Download")', 'a:has-text("Watch")', 'a:has-text("Stream")'
  ];
  for (const sel of downloadSelectors) {
    const link = $(sel).attr('href');
    if (link) try { return new URL(link, page.url()).href; } catch(e) {}
  }
  const iframe = $('iframe').attr('src');
  if (iframe) try { return new URL(iframe, page.url()).href; } catch(e) {}
  return null;
}
