import puppeteer from 'puppeteer-core';
import * as cheerio from 'cheerio';

// ==================== MAIN HANDLER ====================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url, password = null, manualCaptchaSolved = false } = req.body;

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
  let extractedText = null;

  try {
    // Launch browser
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080'
      ],
      headless: 'new'
    });

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
        return res.status(200).json({ success: false, password_required: true, message: 'Password salah.' });
      }
      await page.waitForTimeout(3000);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
    } else if (passwordRequired && !password) {
      await browser.close();
      return res.status(200).json({ success: false, password_required: true, message: 'Password diperlukan.' });
    }

    // ========== 3. HANDLE CAPTCHA (Math captcha otomatis) ==========
    if (captchaDetected && captchaType === 'math_captcha') {
      const solved = await solveMathCaptcha(page);
      if (!solved) {
        await browser.close();
        return res.status(200).json({ success: false, captcha_detected: true, captcha_type: 'math_captcha', message: 'Gagal menyelesaikan math captcha.' });
      }
      await page.waitForTimeout(2000);
    } else if (captchaDetected && !manualCaptchaSolved) {
      await browser.close();
      return res.status(200).json({ success: false, captcha_detected: true, captcha_type: captchaType, message: `Captcha ${captchaType} terdeteksi. Silakan selesaikan manual lalu scan ulang dengan centang.` });
    } else if (captchaDetected && manualCaptchaSolved) {
      console.log('Manual captcha solved flag aktif');
      await page.waitForTimeout(2000);
    }

    // ========== 4. EKSEKUSI KHUSUS UNTUK PASTELINK / PASTEBIN ==========
    if (url.includes('pastelink.net') || url.includes('pastebin.com')) {
      extractedText = await extractPasteContent(page);
      if (extractedText) {
        const links = extractedText.match(/https?:\/\/[^\s<>"']+/g) || [];
        links.forEach(link => allDiscoveredUrls.add(link));
        if (links.length > 0) finalMainLink = links[0];
      }
    }

    // ========== 5. KLIK SEMUA ACTION (Subscribe, Share, Unlock, dll) ==========
    await autoClickAllActions(page);

    // ========== 6. TUNGGU KONTEN UTAMA ==========
    await waitForMainContent(page);

    // ========== 7. EKSTRAK SEMUA LINK ==========
    const pageContent = await page.content();
    const $ = cheerio.load(pageContent);
    const finalUrl = page.url();

    extractAllLinks($, page, allDiscoveredUrls, mp4Links);
    extractLinksFromScripts($, allDiscoveredUrls, mp4Links);
    extractMetaRefreshLinks($, page, allDiscoveredUrls);
    extractVideoSources($, page, mp4Links);

    finalMainLink = finalMainLink || await extractBestLink(page, $, mp4Links);
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
      extracted_text: extractedText ? extractedText.substring(0, 1000) : null,
      captcha_detected: captchaDetected,
      captcha_type: captchaType,
      password_required: passwordRequired,
      message: `✅ Berhasil diproses. ${mp4Links.size} video ditemukan. Link utama: ${finalMainLink}`
    });

  } catch (error) {
    console.error(error);
    if (browser) await browser.close();
    return res.status(500).json({
      success: false,
      error: error.message,
      captcha_detected: captchaDetected,
      password_required: passwordRequired,
      message: 'Terjadi kesalahan server.'
    });
  }
}

// ==================== FUNGSI DETEKSI ====================
async function detectCaptcha(page) {
  const content = await page.content();
  const url = page.url();
  if (/[\d\+\-\*\/]\s*\=/.test(content) || /what is|solve this|math question/i.test(content)) {
    return { detected: true, type: 'math_captcha' };
  }
  if (/recaptcha|g-recaptcha/i.test(content) || /google\.com\/recaptcha/i.test(url)) {
    return { detected: true, type: 'recaptcha' };
  }
  if (/h-captcha/i.test(content)) return { detected: true, type: 'hcaptcha' };
  if (/turnstile|cloudflare\.com\/cdn-cgi\/challenge/i.test(content)) return { detected: true, type: 'turnstile' };
  return { detected: false, type: null };
}

async function detectPasswordProtection(page) {
  if (!await page.$('input[type="password"]')) return false;
  const text = await page.content();
  return /password|enter password|protected page/i.test(text);
}

async function handlePassword(page, password) {
  try {
    const pwd = await page.$('input[type="password"]');
    if (!pwd) return false;
    await pwd.type(password);
    const submit = await page.$('input[type="submit"], button[type="submit"], button:has-text("Submit"), button:has-text("Enter"), button:has-text("Unlock")');
    if (submit) await submit.click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    return true;
  } catch (e) {
    return false;
  }
}

async function solveMathCaptcha(page) {
  try {
    const mathText = await page.evaluate(() => {
      const elements = document.querySelectorAll('.captcha, #captcha, [class*="captcha"], .math, span, div');
      for (let el of elements) {
        const text = el.innerText;
        if (text && /[\d\+\-\*\/]/.test(text)) return text;
      }
      return null;
    });
    if (!mathText) return false;
    const match = mathText.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);
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
    const submit = await page.$('button[type="submit"], input[type="submit"]');
    if (submit) await submit.click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    return true;
  } catch (e) {
    return false;
  }
}

async function extractPasteContent(page) {
  try {
    return await page.evaluate(() => {
      const pre = document.querySelector('pre, .paste-content, #paste_content, .deindent');
      if (pre) return pre.innerText;
      return document.body.innerText;
    });
  } catch (e) {
    return null;
  }
}

// ==================== KLIK OTOMATIS SEMUA ACTION (TERMASUK SUBSCRIBE SIMULASI) ====================
async function autoClickAllActions(page) {
  console.log('🖱️ Mengeksekusi semua aksi otomatis (subscribe, follow, share, unlock)...');

  // 1. Klik semua elemen berdasarkan kata kunci (agresif)
  const keywords = ['subscribe', 'sub now', 'follow', 'share', 'like', 'retweet', 'join', 'unlock', 'continue', 'get link', 'proceed', 'next', 'verify', 'free access', 'watch', 'download', 'click here', 'final step'];
  for (const kw of keywords) {
    const selectors = [
      `a:has-text("${kw}")`, `button:has-text("${kw}")`,
      `[class*="${kw}"]`, `[id*="${kw}"]`, `[aria-label*="${kw}"]`
    ];
    for (const sel of selectors) {
      try {
        const elements = await page.$$(sel);
        for (const el of elements) {
          if (await el.isVisible()) {
            await el.click();
            console.log(`✅ Diklik: ${sel}`);
            await page.waitForTimeout(800);
          }
        }
      } catch (e) {}
    }
  }

  // 2. Klik via evaluate (lebih dalam, termasuk yang tidak punya selector jelas)
  await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, button, div[role="button"], span[role="button"], input[type="button"], input[type="submit"]'));
    const keys = ['subscribe', 'sub', 'follow', 'share', 'like', 'unlock', 'continue', 'get link', 'proceed', 'next', 'verify', 'free access', 'watch', 'download', 'click here'];
    for (const el of all) {
      const txt = (el.innerText || el.value || '').toLowerCase();
      if (keys.some(k => txt.includes(k))) {
        el.click();
      }
    }
  });
  await page.waitForTimeout(2000);

  // 3. Tunggu progress indicator jika ada (misal sub2unlock punya progress 0/1)
  await page.waitForFunction(
    () => {
      const progress = document.querySelector('.unlock-progress, .progress-text, [class*="progress"], .counter');
      if (progress) {
        const text = progress.innerText;
        return text.includes('1/1') || text.includes('Complete') || text.includes('Done');
      }
      return true; // jika tidak ada progress, lanjut
    },
    { timeout: 10000, polling: 500 }
  ).catch(() => console.log('Tidak ada progress indicator, tetap lanjut'));

  // 4. Klik tombol "Unlock Link" atau sejenisnya
  const unlockSelectors = [
    'button:has-text("Unlock Link")', 'a:has-text("Unlock Link")',
    '.unlock-btn', '.btn-unlock', 'button:has-text("Unlock")',
    'a:has-text("Get Link")', 'button:has-text("Continue")',
    'a:has-text("Final Step")', '#unlockBtn', '.get-link'
  ];
  for (const sel of unlockSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        console.log(`✅ Tombol unlock diklik: ${sel}`);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null);
        break;
      }
    } catch(e) {}
  }
}

async function waitForMainContent(page) {
  await page.waitForFunction(
    () => {
      return document.querySelector('video, iframe[src*=".mp4"], a[href*="/download"], a[href*="/v/"], a[href*="/get/"]') !== null;
    },
    { timeout: 30000, polling: 800 }
  ).catch(() => console.log('Timeout menunggu konten utama, tetap ekstrak link yang ada'));
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
    'a[href*="/d/"]', 'a[href*="/download"]', 'a[href*="/get/"]', 'a[href*="/v/"]',
    'a:has-text("Download")', 'a:has-text("Watch")', 'a:has-text("Stream")', 'a:has-text("Link")'
  ];
  for (const sel of downloadSelectors) {
    const link = $(sel).attr('href');
    if (link) try { return new URL(link, page.url()).href; } catch(e) {}
  }
  const iframe = $('iframe').attr('src');
  if (iframe) try { return new URL(iframe, page.url()).href; } catch(e) {}
  return null;
}
