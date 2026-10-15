# بوت الفحص على Railway: Node + Google Chrome (للواتس وبرنامج الفحص) + LibreOffice (تحويل الورد لـ PDF)
# Google Chrome الرسمي مش Chromium تبع Debian: مع Chromium كانت صفحة الواتس تنهار (Page crashed) مع كل رسالة جاية
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Hebron \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    STORAGE_DIR=/app/storage

# Google Chrome من مستودع Google، وخطوط عربي وإنجليزي عشان السير تنرسم صح بالـPDF وبالصور
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      google-chrome-stable \
      libreoffice-writer-nogui \
      fonts-noto-core fonts-liberation fonts-dejavu-core \
      tzdata \
 && apt-get purge -y wget gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# المكتبات أول (بتنحفظ بالكاش وما بتنعاد إلا إذا تغيّر package.json)
COPY package.json package-lock.json .puppeteerrc.cjs ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# /app/storage لازم يكون عليه Volume بـ Railway (جلسة الواتس + قاعدة البيانات)
CMD ["node", "src/bot.js"]
