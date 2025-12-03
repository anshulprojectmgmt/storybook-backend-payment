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
  const pages = await AiKidImageModel.find(
    { req_id, status: "completed" },
    {
      page_number: 1,
      image_urls: 1,
      front_cover_url: 1,
      back_cover_url: 1,
      _id: 0,
    }
  ).lean();

  if (!pages.length) throw new Error("No pages found");

  const frontCoverUrl =
    pages.find((p) => p.front_cover_url)?.front_cover_url || null;
  const backCoverUrl =
    pages.find((p) => p.back_cover_url)?.back_cover_url || null;

  const storyPages = pages
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

  return uploadResult.Location;
}

// import fs from "fs";
// import path from "path";
// import PDFDocument from "pdfkit";
// import axios from "axios";
// import AiKidImageModel from "../models/aiKidImageModel.js";
// import { uploadLocalFileToS3 } from "../controllers/photoController.js";

// async function downloadImageToBuffer(url) {
//   const response = await axios.get(url, { responseType: "arraybuffer" });
//   return Buffer.from(response.data);
// }

// export async function generateStoryPdfForRequest(req_id) {
//   // 1. Get all completed pages + covers for this request
//   const pages = await AiKidImageModel.find(
//     { req_id, status: "completed" },
//     {
//       page_number: 1,
//       image_urls: 1,
//       front_cover_url: 1,
//       back_cover_url: 1,
//       _id: 0,
//     }
//   ).lean();

//   if (!pages || pages.length === 0) {
//     throw new Error("No completed pages found for this request ID");
//   }

//   // 2. Extract covers (if present on any doc)
//   const frontCoverUrl =
//     pages.find((p) => p.front_cover_url)?.front_cover_url || null;
//   const backCoverUrl =
//     pages.find((p) => p.back_cover_url)?.back_cover_url || null;

//   // 3. Sort normal story pages by page_number
//   const storyPages = pages
//     .filter((p) => typeof p.page_number === "number")
//     .sort((a, b) => a.page_number - b.page_number);

//   // 4. Build ordered list: front cover → pages → back cover
//   const orderedUrls = [];

//   if (frontCoverUrl) orderedUrls.push(frontCoverUrl);

//   for (const p of storyPages) {
//     const marginUrl =
//       Array.isArray(p.image_urls) && p.image_urls[1]
//         ? p.image_urls[1]
//         : p.image_urls[0];
//     if (marginUrl) orderedUrls.push(marginUrl);
//   }

//   if (backCoverUrl) orderedUrls.push(backCoverUrl);

//   if (orderedUrls.length === 0) {
//     throw new Error("No image URLs found for PDF");
//   }

//   // 5. Create PDF in /tmp
//   const fileName = `storybook_${req_id}_${Date.now()}.pdf`;
//   const localPath = path.join("/tmp", fileName);

//   const doc = new PDFDocument({
//     autoFirstPage: false,
//     size: "A4",
//     margin: 0,
//   });

//   const writeStream = fs.createWriteStream(localPath);
//   doc.pipe(writeStream);

//   // 6. Add each image as full page
//   for (const url of orderedUrls) {
//     const imgBuffer = await downloadImageToBuffer(url);

//     doc.addPage();
//     const pageWidth = doc.page.width;
//     const pageHeight = doc.page.height;

//     doc.image(imgBuffer, 0, 0, {
//       width: pageWidth,
//       height: pageHeight,
//     });
//   }

//   doc.end();

//   await new Promise((resolve, reject) => {
//     writeStream.on("finish", resolve);
//     writeStream.on("error", reject);
//   });

//   // 7. Upload PDF to S3
//   const uploadResult = await uploadLocalFileToS3(
//     localPath,
//     `storybook_pdfs/${fileName}`,
//     "application/pdf"
//   );

//   try {
//     fs.unlinkSync(localPath);
//   } catch (e) {
//     console.warn("Could not delete temp PDF file:", e.message);
//   }

//   return uploadResult.Location; // ✅ S3 URL of final PDF
// }
