import axios from "axios";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { uploadLocalFileToS3 } from "../controllers/photoController.js";

// Rounded rectangle helper
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * MAIN FUNCTION
 * Generates the final front cover (Placid-style)
 * Accepts:
 *  - storyImageUrl (S3 URL of last page)
 *  - childName (string)
 * Returns:
 *  - S3 URL of generated cover
 */
export async function createFrontCoverCanvas(
  storyImageUrl,
  childName,
  logoUrl,
  bookTitle
) {
  console.log("🎨 Generating Front Cover…");

  // 1) Fetch story page from S3
  const response = await axios.get(storyImageUrl, {
    responseType: "arraybuffer",
  });
  const originalBuffer = Buffer.from(response.data);

  // 2) Resize to EXACT print size (3508 × 2480)
  const resizedBuffer = await sharp(originalBuffer)
    .resize(3508, 2480, { fit: "cover" })
    .toBuffer();

  // 3) Load screenshot into canvas
  const storyImg = await loadImage(resizedBuffer);
  const W = 3508;
  const H = 2480;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Draw resized image
  ctx.drawImage(storyImg, 0, 0, W, H);

  // 4) Logo
  const logoBuffer = await axios.get(logoUrl, { responseType: "arraybuffer" });
  const logoImg = await loadImage(logoBuffer.data);
  const logoSize = Math.round(W * 0.13);

  ctx.drawImage(logoImg, W - logoSize - 35, 35, logoSize, logoSize);
  // ctx.drawImage(logoImg, W - logoSize - 200, 200, logoSize, logoSize);

  /* ---------------------------------------------
        TITLE  (A MAGICAL STORY)
  ----------------------------------------------*/
  console.log(bookTitle);
  const title = (bookTitle || "").toUpperCase();
  const titleFontSize = 180;
  const titleLineHeight = 200;

  ctx.font = `${titleFontSize}px Montserrat`;
  const letterSpacing = titleFontSize * 0.035;

  // Measure real width
  let realTitleWidth = 0;
  for (let i = 0; i < title.length; i++) {
    realTitleWidth += ctx.measureText(title[i]).width + letterSpacing;
  }
  realTitleWidth -= letterSpacing;

  const padX = 40;
  const padY = 35;

  const barW = realTitleWidth + padX * 2;
  const barH = titleLineHeight + padY * 2;

  const barX = W / 2 - barW / 2;
  const barY = H * 0.6;

  // Transparent black background
  ctx.fillStyle = "rgba(0,0,0,0.60)";
  roundRect(ctx, barX, barY, barW, barH, 18);
  ctx.fill();

  // Shadow
  ctx.shadowColor = "#3FA666";
  ctx.shadowOffsetX = 10;
  ctx.shadowOffsetY = 2;

  // Draw text
  ctx.fillStyle = "#C849E7";
  ctx.textBaseline = "middle";

  let tx = W / 2 - realTitleWidth / 2;
  let ty = barY + barH / 2;

  for (let i = 0; i < title.length; i++) {
    ctx.fillText(title[i], tx, ty);
    tx += ctx.measureText(title[i]).width + letterSpacing;
  }

  // Reset shadow
  ctx.shadowColor = "transparent";
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  /* ---------------------------------------------
        NAME BOX
  ----------------------------------------------*/

  const nameText = ` For ${childName} `;
  const nameFontSize = 150;
  const nameLineHeight = 140;

  ctx.font = `italic ${nameFontSize}px Georgia`; // freer alternative
  const nameWidth = ctx.measureText(nameText).width;

  const nPadX = 40;
  const nPadY = 30;

  const nbW = nameWidth + nPadX * 2;
  const nbH = nameLineHeight + nPadY * 2;
  const nbX = W / 2 - nbW / 2;
  const nbY = H * 0.78;

  // Background
  ctx.fillStyle = "#BCD6F69C";
  roundRect(ctx, nbX, nbY, nbW, nbH, 18);
  ctx.fill();

  // Border
  ctx.strokeStyle = "#0070F4";
  ctx.lineWidth = 1;
  roundRect(ctx, nbX, nbY, nbW, nbH, 18);
  ctx.stroke();

  // Text
  ctx.fillStyle = "#0D0D0D";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(nameText, W / 2, nbY + nbH / 2);

  /* ---------------------------------------------
        EXPORT + UPLOAD
  ----------------------------------------------*/

  const buffer = canvas.toBuffer("image/jpeg", { quality: 0.95 });

  const fileName = `front_cover_${Date.now()}.jpg`;
  const localPath = path.join("/tmp", fileName);

  fs.writeFileSync(localPath, buffer);

  const upload = await uploadLocalFileToS3(
    localPath,
    `storybook_covers/${fileName}`,
    "image/jpeg"
  );

  console.log("📤 FRONT COVER READY:", upload.Location);
  return upload.Location;
}
