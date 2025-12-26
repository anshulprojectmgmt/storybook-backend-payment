import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import axios from "axios";
import AiKidImageModel from "../models/aiKidImageModel.js";
import { uploadLocalFileToS3 } from "../controllers/photoController.js";

async function downloadImageToBuffer(url) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(response.data);
}

export async function generateStoryPdfForRequest(req_id) {
  console.log("in pdf code request id is ", req_id);
  const pages = await AiKidImageModel.find(
    { req_id },
    {
      page_number: 1,
      image_urls: 1,
      front_cover_url: 1,
      back_cover_url: 1,
      status: 1,
      _id: 0,
    }
  ).lean();

  const completedPages = pages.filter(
    (p) =>
      p.status === "completed" &&
      Array.isArray(p.image_urls) &&
      p.image_urls.length > 0
  );

  if (!completedPages.length) {
    throw new Error("No completed pages available for PDF");
  }

  if (!pages.length) {
    console.error("❌ PDF aborted: no completed pages for", req_id);
    return null;
  }

  const frontCoverUrl = pages.find((p) => p.front_cover_url)?.front_cover_url;
  const backCoverUrl = pages.find((p) => p.back_cover_url)?.back_cover_url;

  const storyPages = completedPages
    .filter((p) => typeof p.page_number === "number")
    .sort((a, b) => a.page_number - b.page_number);

  const orderedUrls = [];

  if (frontCoverUrl) orderedUrls.push(frontCoverUrl);

  for (const p of storyPages) {
    const marginUrl =
      Array.isArray(p.image_urls) && p.image_urls[1]
        ? p.image_urls[1] // ✔ Margin version
        : p.image_urls[0];
    if (marginUrl) orderedUrls.push(marginUrl);
  }

  if (backCoverUrl) orderedUrls.push(backCoverUrl);

  const fileName = `storybook_${req_id}_${Date.now()}.pdf`;
  const localPath = path.join("/tmp", fileName);

  // 🟢 Set PDF to LANDSCAPE A4
  const doc = new PDFDocument({
    autoFirstPage: false,
    size: "A4",
    layout: "landscape",
    margin: 0,
  });

  const writeStream = fs.createWriteStream(localPath);
  doc.pipe(writeStream);

  for (const url of orderedUrls) {
    const imgBuffer = await downloadImageToBuffer(url);

    doc.addPage();

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;

    // 🟢 Fill entire A4 Landscape page
    doc.image(imgBuffer, 0, 0, {
      width: pageWidth,
      height: pageHeight,
    });
  }

  doc.end();

  await new Promise((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  const uploadResult = await uploadLocalFileToS3(
    localPath,
    `storybook_pdfs/${fileName}`,
    "application/pdf"
  );

  try {
    fs.unlinkSync(localPath);
  } catch {}
  console.log("📄 PDF GENERATED:", uploadResult.Location);

  return uploadResult.Location;
}
