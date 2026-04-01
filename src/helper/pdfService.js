import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import axios from "axios";
import AiKidImageModel from "../models/aiKidImageModel.js";
import { uploadLocalFileToS3 } from "../controllers/photoController.js";
import ParentModel from "../models/parentModel.js";

async function downloadImageToBuffer(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
  });
  return Buffer.from(response.data);
}

function getSelectedPrintUrl(page) {
  if (Array.isArray(page.image_options) && page.image_options.length > 0) {
    const safeIndex =
      typeof page.image_idx === "number" &&
      page.image_idx >= 0 &&
      page.image_idx < page.image_options.length
        ? page.image_idx
        : 0;

    const selectedOption =
      page.image_options[safeIndex] || page.image_options[0];

    return selectedOption?.print_url || selectedOption?.preview_url || null;
  }

  if (Array.isArray(page.image_urls) && page.image_urls.length > 1) {
    return page.image_urls[1];
  }

  return Array.isArray(page.image_urls) ? page.image_urls[0] || null : null;
}

export async function generateStoryPdfForRequest(req_id) {
  const parent = await ParentModel.findOne({ req_id });
  if (!parent || parent.payment !== "paid") {
    throw new Error("Payment not completed.pdf generation blocked.");
  }

  const pages = await AiKidImageModel.find(
    { req_id },
    {
      page_number: 1,
      image_urls: 1,
      image_options: 1,
      image_idx: 1,
      front_cover_url: 1,
      back_cover_url: 1,
      status: 1,
      _id: 0,
    },
  ).lean();

  const completedPages = pages.filter(
    (page) =>
      page.status === "completed" &&
      (getSelectedPrintUrl(page) || page.front_cover_url || page.back_cover_url),
  );

  if (!completedPages.length) {
    throw new Error("No completed pages available for PDF");
  }

  if (!pages.length) {
    console.error("PDF aborted: no completed pages for", req_id);
    return null;
  }

  const frontCoverUrl = pages.find((page) => page.front_cover_url)?.front_cover_url;
  const backCoverUrl = pages.find((page) => page.back_cover_url)?.back_cover_url;

  const storyPages = completedPages
    .filter((page) => typeof page.page_number === "number")
    .sort((a, b) => a.page_number - b.page_number);

  const orderedUrls = [];

  if (frontCoverUrl) orderedUrls.push(frontCoverUrl);

  for (const page of storyPages) {
    const selectedPrintUrl = getSelectedPrintUrl(page);
    if (selectedPrintUrl) {
      orderedUrls.push(selectedPrintUrl);
    }
  }

  if (backCoverUrl) orderedUrls.push(backCoverUrl);

  const fileName = `storybook_${req_id}_${Date.now()}.pdf`;
  const localPath = path.join("/tmp", fileName);

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
    "application/pdf",
  );

  try {
    fs.unlinkSync(localPath);
  } catch {}

  console.log("PDF GENERATED:", uploadResult.Location);
  return uploadResult.Location;
}
