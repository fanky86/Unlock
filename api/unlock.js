import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import axios from 'axios';
import * as cheerio from 'cheerio';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url, password = null, manualCaptchaSolved = false } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let browser = null;
  const allDiscoveredUrls = new Set();
  const mp4Links = new Set();
  const redirectChain = [];
  let captchaDetected = false;
  let captchaType = null;
  let passwordRequired = false;

  try {
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Monitor semua response untuk tracking redirect & MP4
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
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000, referer: 'https://google.com' });

    // Deteksi captcha
    const captchaResult = await detectCaptcha(page);
    captchaDetected = captchaResult.detected;
    captchaType = captchaResult.type;

    // Deteksi password protection
    passwordRequired = await detectPasswordProtection(page);

    // Jika ada password dan user memberikan password
    if (passwordRequired && password) {
      await handlePasswordInput(page, password);
      await page.waitForTimeout(3000);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
    }

    // Jika captcha terdeteksi dan user sudah manual solve
    if (captchaDetected && manualCaptchaSolved) {
      console.log('User indicated captcha sudah di-solve manual');
      await page.waitForTimeout(2000);
    }

    // Handle klik tombol unlock biasa (tanpa captcha)
    if (!captchaDetected || manualCaptchaSolved) {
      await clickUnlockButtons(page);
    }

    // Tunggu redirect atau konten muncul
    await page.waitForFunction(
      () => {
        const hasVideo = document.querySelector('video, iframe[src*=".mp4"], source');
        const hasLinks = document.querySelectorAll('a[href*=".mp4"], a[href*="/d/"], a[href*="/download"]').length > 0;
        return hasVideo || hasLinks || document.querySelector('.player-container, #video-player');
      },
      { timeout: 30000, polling: 1000 }
    ).catch(() => console.log('Timeout menunggu video, mengekstrak apa yang ada...'));

    // Ekstrak semua konten
    const pageContent = await page.content();
    const $ = cheerio.load(pageContent);
    const finalUrl = page.url();
    
    // Extract semua link dari berbagai source
    extractAllLinks($, page, allDiscoveredUrls, mp4Links);
    
    // Extract link dari script
    extractLinksFromScripts($, allDiscoveredUrls, mp4Links);
    
    // Extract dari meta refresh
    extractMetaRefreshLinks($, page, allDiscoveredUrls);
    
    // Extract video sources
    extractVideoSources($, page, mp4Links);
    
    const mainContentLink = await extractBestLink(page, $, mp4Links);

    await browser.close();

    const result = {
      success: true,
      original_url: url,
      final_url: finalUrl,
      redirect_chain: redirectChain,
      all_discovered_urls: Array.from(allDiscoveredUrls).slice(0, 50),
      mp4_links: Array.from(mp4Links),
      main_content_link: mainContentLink || finalUrl,
      is_video: mp4Links.size > 0,
      total_mp4_found: mp4Links.size,
      captcha_detected: captchaDetected,
      captcha_type: captchaType,
      password_required: passwordRequired,
      message: buildMessage(captchaDetected, captchaType, passwordRequired, mp4Links.size)
    };
    
    return res.status(200).json(result);
    
  } catch (error) {
    console.error(error);
    if (browser) await browser.close();
    return res.status(500).json({
      success: false,
      error: error.message,
      captcha_detected: captchaDetected,
      password_required: passwordRequired,
      partial_mp4_links: Array.from(mp4Links),
      message: 'Terjadi error, beberapa link mungkin sudah terdeteksi'
    });
  }
}

// ==================== DETECTION FUNCTIONS ====================

async function detectCaptcha(page) {
  const pageContent = await page.content();
  const pageUrl = page.url();
  
  const captchaIndicators = {
    recaptcha: ['recaptcha', 'g-recaptcha', 'google.com/recaptcha', 'api.recaptcha'],
    hcaptcha: ['hcaptcha', 'h-captcha'],
    turnstile: ['turnstile', 'cloudflare.com/cdn-cgi/challenge'],
    text_captcha: ['captcha code', 'enter captcha', 'verification code', 'type the text'],
    math_captcha: ['what is', 'solve this', 'math question', 'calculate'],
    slider: ['slide to verify', 'drag the slider', 'slide captcha']
  };
  
  for (const [type, indicators] of Object.entries(captchaIndicators)) {
    for (const indicator of indicators) {
      if (pageContent.toLowerCase().includes(indicator) || pageUrl.toLowerCase().includes(indicator)) {
        // Cek juga di frame
        const frames = page.frames();
        for (const frame of frames) {
          const frameUrl = frame.url();
          if (frameUrl.toLowerCase().includes(indicator)) {
            return { detected: true, type: type };
          }
        }
        return { detected: true, type: type };
      }
    }
  }
  
  // Cek elemen visual captcha
  const captchaElement = await page.$('.captcha, #captcha, .g-recaptcha, .h-captcha, [class*="captcha"]').catch(() => null);
  if (captchaElement) {
    return { detected: true, type: 'generic_captcha' };
  }
  
  return { detected: false, type: null };
}

async function detectPasswordProtection(page) {
  const pageContent = await page.content();
  const indicators = ['password', 'enter password', 'protected page', 'authentication required', 'enter the password'];
  
  for (const indicator of indicators) {
    if (pageContent.toLowerCase().includes(indicator)) {
      const passwordInput = await page.$('input[type="password"]');
      if (passwordInput) {
        return true;
      }
    }
  }
  return false;
}

async function handlePasswordInput(page, password) {
  console.log('🔐 Memasukkan password...');
  try {
    const passwordInput = await page.$('input[type="password"]');
    if (passwordInput) {
      await passwordInput.type(password);
      const submitBtn = await page.$('input[type="submit"], button[type="submit"], button:has-text("Submit"), button:has-text("Enter")');
      if (submitBtn) {
        await submitBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      console.log('✅ Password submitted');
    }
  } catch (error) {
    console.log('Gagal memasukkan password:', error.message);
  }
}

async function clickUnlockButtons(page) {
  const selectors = [
    'a:has-text("Unlock")', 'a:has-text("Continue")', 'a:has-text("Get Link")',
    'a:has-text("Click here")', 'button:has-text("Unlock")', 'button:has-text("Verify")',
    'button:has-text("I am human")', '.btn-unlock', '#unlock-btn', '.get-link',
    'a[href*="/go/"]', 'a[href*="/get/"]', 'input[value="Unlock"]',
    'a:has-text("Free Access")', 'a:has-text("Watch Video")'
  ];
  
  for (const selector of selectors) {
    try {
      const btn = await page.$(selector);
      if (btn && await btn.isVisible()) {
        await btn.click();
        console.log(`✅ Clicked: ${selector}`);
        await page.waitForTimeout(2000);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => null);
      }
    } catch(e) {}
  }
}

// ==================== EXTRACTION FUNCTIONS ====================

function extractAllLinks($, page, allDiscoveredUrls, mp4Links) {
  // Extract dari semua tag <a>
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      try {
        const absoluteUrl = new URL(href, page.url()).href;
        allDiscoveredUrls.add(absoluteUrl);
        if (absoluteUrl.match(/\.(mp4|m3u8|webm|mkv|avi|mov)(\?.*)?$/i)) {
          mp4Links.add(absoluteUrl);
        }
      } catch(e) {}
    }
  });
  
  // Extract dari iframe
  $('iframe[src], frame[src]').each((i, el) => {
    const src = $(el).attr('src');
    if (src) {
      try {
        const absoluteUrl = new URL(src, page.url()).href;
        allDiscoveredUrls.add(absoluteUrl);
      } catch(e) {}
    }
  });
  
  // Extract dari embed
  $('embed[src], object[data]').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data');
    if (src) {
      try {
        const absoluteUrl = new URL(src, page.url()).href;
        allDiscoveredUrls.add(absoluteUrl);
      } catch(e) {}
    }
  });
}

function extractLinksFromScripts($, allDiscoveredUrls, mp4Links) {
  const scripts = $('script').map((i, el) => $(el).html()).get();
  const urlRegex = /(https?:\/\/[^\s"'<>(){}|\\^`[\]]+)/gi;
  
  scripts.forEach(script => {
    if (script) {
      const foundUrls = script.match(urlRegex) || [];
      foundUrls.forEach(foundUrl => {
        try {
          const cleanUrl = foundUrl.replace(/['"]/g, '');
          allDiscoveredUrls.add(cleanUrl);
          if (cleanUrl.match(/\.(mp4|m3u8|webm|mkv)(\?.*)?$/i)) {
            mp4Links.add(cleanUrl);
          }
        } catch(e) {}
      });
    }
  });
}

function extractMetaRefreshLinks($, page, allDiscoveredUrls) {
  const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
  if (metaRefresh && metaRefresh.includes('url=')) {
    const hiddenUrl = decodeURIComponent(metaRefresh.split('url=')[1]);
    try {
      const absoluteUrl = new URL(hiddenUrl, page.url()).href;
      allDiscoveredUrls.add(absoluteUrl);
    } catch(e) {}
  }
}

function extractVideoSources($, page, mp4Links) {
  // Video tag
  $('video source, video').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) {
      try {
        const absoluteUrl = new URL(src, page.url()).href;
        mp4Links.add(absoluteUrl);
      } catch(e) {}
    }
  });
  
  // Player sources
  $('[data-video], [data-mp4], [data-src*="mp4"]').each((i, el) => {
    const dataSrc = $(el).attr('data-video') || $(el).attr('data-mp4') || $(el).attr('data-src');
    if (dataSrc && dataSrc.includes('mp4')) {
      try {
        const absoluteUrl = new URL(dataSrc, page.url()).href;
        mp4Links.add(absoluteUrl);
      } catch(e) {}
    }
  });
}

async function extractBestLink(page, $, mp4Links) {
  // Priority 1: MP4 links
  if (mp4Links.size > 0) {
    return Array.from(mp4Links)[0];
  }
  
  // Priority 2: Download links
  const downloadSelectors = [
    'a[href*="/d/"]', 'a[href*="/download"]', 'a[href*="/get/"]',
    'a:has-text("Download")', 'a:has-text("Watch")', 'a:has-text("Stream")'
  ];
  
  for (const selector of downloadSelectors) {
    const link = $(selector).attr('href');
    if (link) {
      try {
        return new URL(link, page.url()).href;
      } catch(e) {}
    }
  }
  
  // Priority 3: Iframe
  const iframe = $('iframe').attr('src');
  if (iframe) {
    try {
      return new URL(iframe, page.url()).href;
    } catch(e) {}
  }
  
  return null;
}

function buildMessage(captchaDetected, captchaType, passwordRequired, mp4Count) {
  const messages = [];
  
  if (captchaDetected) {
    messages.push(`⚠️ Captcha terdeteksi (${captchaType}). Silakan selesaikan captcha secara manual di browser terlebih dahulu.`);
  }
  
  if (passwordRequired) {
    messages.push(`🔐 Link membutuhkan password. Masukkan password pada form yang tersedia.`);
  }
  
  if (mp4Count > 0) {
    messages.push(`🎉 Ditemukan ${mp4Count} video MP4! Video siap diputar.`);
  } else if (!captchaDetected && !passwordRequired) {
    messages.push(`✅ Link berhasil di-scan. Silakan lihat link utama di bawah.`);
  }
  
  return messages.join(' ');
}
