# بوت الفحص على Railway: Node + Chromium (للواتس وبرنامج الفحص) + LibreOffice (تحويل الورد لـ PDF)
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Hebron \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    STORAGE_DIR=/app/storage

# خطوط عربي وإنجليزي عشان السير تنرسم صح بالـPDF وبالصور
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      libreoffice-writer-nogui \
      fonts-noto-core fonts-liberation fonts-dejavu-core \
      tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# المكتبات أول (بتنحفظ بالكاش وما بتنعاد إلا إذا تغيّر package.json)
COPY package.json package-lock.json .puppeteerrc.cjs ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# /app/storage لازم يكون عليه Volume بـ Railway (جلسة الواتس + قاعدة البيانات)
CMD ["node", "src/bot.js"]
