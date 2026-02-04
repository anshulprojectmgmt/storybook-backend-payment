import AWS from "aws-sdk";
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
// import Jimp from "jimp";
import sharp from "sharp";
import { createCanvas, loadImage } from "@napi-rs/canvas";

import KidPhotoModel from "../models/kidPhotoModel.js";
import SceneModel from "../models/sceneModel.js";
import StoryBookModel from "../models/StoryBookModel.js";
import AiKidImageModel from "../models/aiKidImageModel.js";
import ParentModel from "../models/parentModel.js";
// import nodemailer from "nodemailer";
import axios from "axios";
import FormData from "form-data";
import sgMail from "@sendgrid/mail";
// import { createBackCover } from "../helper/createBackCover.js";
// import { createFrontCoverWithLogo } from "../helper/createFrontCoverWithLogo.js";
import { createFrontCoverCanvas } from "../helper/createFrontCoverCanvas.js";
import { addFixedPrintMargin } from "../helper/addFixedPrintMargin.js";
import { generateStoryPdfForRequest } from "../helper/pdfService.js";

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const s3 = new AWS.S3({
  accessKeyId: process.env.PROD_AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.PROD_AWS_SECRET_ACCESS_KEY,
  region: process.env.PROD_AWS_REGION,
  maxRetries: 3,
  httpOptions: {
    timeout: 15000,
  },
});

const REMAKER_API_KEY = process.env.REMAKER_API_KEY;
const CREATE_JOB_URL =
  "https://developer.remaker.ai/api/remaker/v1/face-swap/create-job";

/** Utility: fetch S3 object as Buffer */

export async function fetchS3Buffer(s3Url) {
  try {
    const url = new URL(s3Url);

    // Handles ALL S3 formats including region-based
    if (url.hostname.includes("s3")) {
      const bucket = url.hostname.split(".s3")[0];
      const key = decodeURIComponent(url.pathname.slice(1));

      const data = await s3
        .getObject({
          Bucket: bucket,
          Key: key,
        })
        .promise();

      return data.Body;
    }

    throw new Error("Non-S3 URL is not allowed here");
  } catch (err) {
    console.error("❌ S3 fetch failed:", s3Url, err.message);
    throw err;
  }
}

export const storeOriginalImageToS3 = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded", ok: false });
    }

    // Read the file from disk
    // const filePath = path.join("uploads", req.file.filename);
    const filePath = req.file.path; // ✅ Use full path provided by multer
    const fileContent = fs.readFileSync(filePath);

    const params = {
      Bucket: process.env.PROD_AWS_S3_BUCKET_NAME,
      Key: `original_images/${Date.now()}_${req.file.originalname}`,
      Body: fileContent,
      ContentType: req.file.mimetype,
    };

    const uploadResult = await s3.upload(params).promise();
    // console.log("File uploaded successfully:");
    // Optionally delete the file from disk after upload
    fs.unlinkSync(filePath);
    res.status(200).json({
      file_url: uploadResult.Location,
      upload_url: uploadResult.Key,
      ok: true,
    });
  } catch (error) {
    console.error("Error uploading to S3:", error);
    res.status(500).json({ error: "Failed to upload file", ok: false });
  }
};

export const add_photoToDB = async (req, res) => {
  try {
    const { file_url, file_name, request_id } = req.body;
    const photoDetails = {
      file_url,
      file_name,
      request_id,
    };

    // Save to database (pseudo code)
    const result = await KidPhotoModel.create(photoDetails);
    // await savePhotoToDatabase(photoDetails);

    res.status(200).json({
      message: "Photo added successfully",
      photo_id: result._id,
      ok: true,
    });
  } catch (error) {
    console.error("Error adding photo to DB:", error);
    res.status(500).json({ error: "Failed to add photo", ok: false });
  }
};

/**
 * Takes an image buffer and adds caption text with translucent rounded background.
 * Returns modified buffer (JPEG).
 */

async function addCaptionWithCanva(imageBuffer, captionText) {
  const img = sharp(imageBuffer);
  const { width, height } = await img.metadata();

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const base = await loadImage(imageBuffer);
  ctx.drawImage(base, 0, 0, width, height);

  // Increased bar height visibility ~20%
  const barHeight = Math.floor(height * 0.2);

  // 🌥 Darker + softer fade background for better contrast
  const cloud = ctx.createLinearGradient(0, height - barHeight, 0, height);
  cloud.addColorStop(0, "rgba(0, 0, 0, 0.40)"); // slight fade start
  cloud.addColorStop(1, "rgba(0, 0, 0, 0.80)"); // stronger dark anchor
  ctx.fillStyle = cloud;
  ctx.fillRect(0, height - barHeight, width, barHeight);

  // Auto font size
  // ⭐ CHANGE #1 – Reduce font size (0.30 → 0.24)
  let fontSize = Math.floor(barHeight * 0.24);
  ctx.font = `${fontSize}px Sans-Serif`;

  function wrapText(text) {
    const words = text.split(" ");
    let line = "",
      lines = [];
    for (let w of words) {
      const test = line + w + " ";
      if (ctx.measureText(test).width > width * 0.83) {
        lines.push(line.trim());
        line = "";
      }
      line += w + " ";
    }
    lines.push(line.trim());
    return lines;
  }

  let lines = wrapText(captionText);
  let lineHeight = fontSize * 1.35;

  // Auto-shrink if needed
  while (lines.length * lineHeight > barHeight * 0.92) {
    fontSize -= 2;
    ctx.font = `${fontSize}px Sans-Serif`;
    lineHeight = fontSize * 1.35;
    lines = wrapText(captionText);
  }

  // ⭐ CHANGE #2 – Move caption UP by 10px from bottom
  const centerY =
    height - barHeight / 2 - ((lines.length - 1) * lineHeight) / 2 - 10;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 🌌 Cool Blue Fantasy Gradient (same as earlier, kept)
  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0.0, "#A8C8FF");
  gradient.addColorStop(0.35, "#7BB6FF");
  gradient.addColorStop(0.7, "#B8A8FF");
  gradient.addColorStop(1.0, "#E0DDFF");

  lines.forEach((line, i) => {
    const y = centerY + i * lineHeight;

    // ✨ Stronger Glow for highlight
    ctx.save();
    ctx.shadowColor = "rgba(180, 210, 255, 1)";
    ctx.shadowBlur = fontSize * 2.4;
    ctx.fillStyle = gradient;
    ctx.fillText(line, width / 2, y);
    ctx.restore();

    // 🖋 Stronger Edge Stroke for readability
    ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
    ctx.lineWidth = fontSize * 0.12;
    ctx.strokeText(line, width / 2, y);

    // Crisp gradient text top layer
    ctx.fillStyle = gradient;
    ctx.fillText(line, width / 2, y);
  });

  return canvas.toBuffer("image/jpeg");
}

export const getGeneratedImage = async (req, res) => {
  const { req_id, page_number, book_id, childName } = req.query;

  try {
    const pageNum = parseInt(page_number);

    /* =====================================================
       🔐 STEP 1: PAYMENT GATING (pages > 3)
       ===================================================== */
    if (pageNum > 3) {
      const parent = await ParentModel.findOne({ req_id });

      if (!parent || parent.payment !== "paid") {
        return res.status(403).json({
          ok: false,
          locked: true,
          message: "Payment required to unlock full book",
        });
      }
    }

    /* =====================================================
       ♻️ STEP 2: RESUME GUARD (idempotent)
       ===================================================== */
    const existing = await AiKidImageModel.findOne({
      req_id,
      book_id,
      page_number: pageNum,
    });

    if (existing) {
      return res.status(200).json({
        job_id: existing.job_id,
        ok: true,
        resumed: true,
      });
    }

    /* =====================================================
       📸 STEP 3: FETCH SOURCE IMAGES
       ===================================================== */
    const originalImages = await KidPhotoModel.find(
      { request_id: req_id },
      { file_url: 1 },
    );

    if (!originalImages?.length) {
      return res.status(404).json({
        ok: false,
        error: "No source images found",
      });
    }

    const sceneDetails = await SceneModel.findOne({
      book_id,
      page_number: pageNum,
    });

    const target_url = sceneDetails?.sceneUrl || "";
    const swap_url = originalImages[0]?.file_url || "";

    if (
      !target_url.startsWith("https://") ||
      !swap_url.startsWith("https://")
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid S3 URLs",
      });
    }

    /* =====================================================
       🧠 STEP 4: REMAKER JOB CREATION
       ===================================================== */
    const targetBuffer = await fetchS3Buffer(target_url);
    const swapBuffer = await fetchS3Buffer(swap_url);

    const form = new FormData();
    form.append(
      "target_image",
      await sharp(targetBuffer).jpeg({ quality: 85 }).toBuffer(),
      { filename: "target.jpg" },
    );
    form.append(
      "swap_image",
      await sharp(swapBuffer).jpeg({ quality: 85 }).toBuffer(),
      { filename: "swap.jpg" },
    );

    const response = await axios.post(CREATE_JOB_URL, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: REMAKER_API_KEY,
      },
      timeout: 180000,
      maxBodyLength: Infinity,
    });

    if (response.data.code !== 100000) {
      return res.status(500).json({
        ok: false,
        error: "Remaker job creation failed",
      });
    }

    const jobId = response.data.result.job_id;

    /* =====================================================
       🧾 STEP 5: IDEMPOTENT INSERT
       ===================================================== */
    await AiKidImageModel.updateOne(
      { req_id, book_id, page_number: pageNum },
      {
        $setOnInsert: {
          job_id: jobId,
          status: "pending",
          image_urls: null,
          image_idx: 0,
          front_cover_url: null,
          back_cover_url: null,
          created_at: new Date(),
        },
        $set: { updated_at: new Date() },
      },
      { upsert: true },
    );

    /* =====================================================
       🔁 STEP 6: POLLING + POST PROCESS
       ===================================================== */
    (function poll(attempt = 0) {
      if (attempt > 20) return;

      setTimeout(async () => {
        try {
          const result = await pollFaceSwap(jobId);

          if (result?.code !== 100000) {
            return poll(attempt + 1);
          }

          /* ---------- IMAGE PROCESSING ---------- */
          const imgRes = await fetch(result.result.output_image_url[0]);
          const baseBuffer = Buffer.from(await imgRes.arrayBuffer());

          let captionText =
            sceneDetails?.scene?.replaceAll("{kid}", childName) ||
            "Your AI story";

          const captioned = await addCaptionWithCanva(baseBuffer, captionText);
          const margin = await addFixedPrintMargin(captioned, pageNum);

          const captionPath = `/tmp/${jobId}_caption.jpg`;
          const marginPath = `/tmp/${jobId}_margin.jpg`;

          fs.writeFileSync(captionPath, captioned);
          fs.writeFileSync(marginPath, margin);

          const captionUpload = await uploadLocalFileToS3(
            captionPath,
            `ai_generated_images/${jobId}_caption.jpg`,
          );
          const marginUpload = await uploadLocalFileToS3(
            marginPath,
            `ai_generated_images/${jobId}_margin.jpg`,
          );

          await AiKidImageModel.updateOne(
            { job_id: jobId },
            {
              $set: {
                status: "completed",
                image_urls: [captionUpload.Location, marginUpload.Location],
                updated_at: new Date(),
              },
            },
          );

          /* =====================================================
             📘 FINAL PAGE → FRONT / BACK COVER + PDF
             ===================================================== */
          const book = await StoryBookModel.findById(book_id);

          if (pageNum === book.page_count) {
            // Back cover
            if (process.env.DEFAULT_BACK_COVER_URL) {
              await AiKidImageModel.updateOne(
                { req_id },
                {
                  $set: {
                    back_cover_url: process.env.DEFAULT_BACK_COVER_URL,
                  },
                },
              );
            }
            // Upload last page
            const lastPagePath = `/tmp/${jobId}_last.jpg`;
            fs.writeFileSync(lastPagePath, baseBuffer);

            const lastUpload = await uploadLocalFileToS3(
              lastPagePath,
              `storybook_pages/${jobId}_last.jpg`,
            );
            // Front cover
            const frontCoverUrl = await createFrontCoverCanvas(
              lastUpload.Location,
              childName,
              process.env.COMPANY_LOGO_URL,
              book.title,
            );

            await AiKidImageModel.updateOne(
              { req_id },
              { $set: { front_cover_url: frontCoverUrl } },
            );

            /* ---------- PDF ---------- */
            const pdfUrl = await generateStoryPdfForRequest(req_id);

            const parent = await ParentModel.findOneAndUpdate(
              { req_id },
              { $set: { pdf_url: pdfUrl } },
              { upsert: true, new: true },
            );

            if (parent?.email && !parent.pdf_email_sent) {
              await sendMail(
                req_id,
                parent.name,
                parent.kidName,
                book_id,
                parent.email,
                false,
                true,
              );

              await ParentModel.updateOne(
                { req_id },
                { $set: { pdf_email_sent: true } },
              );
            }
          }

          fs.unlinkSync(captionPath);
          fs.unlinkSync(marginPath);
        } catch (err) {
          poll(attempt + 1);
        }
      }, 5000);
    })();

    return res.status(200).json({ ok: true, job_id: jobId });
  } catch (err) {
    console.error("getGeneratedImage error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to generate image",
    });
  }
};

// Old stable code before payment integration
// export const getGeneratedImage = async (req, res) => {
//   const { req_id, page_number, book_id, childName } = req.query;

//   try {
//     /* =========================
//        FIX-3 STEP 1: RESUME GUARD
//        ========================= */

//     const existing = await AiKidImageModel.findOne({
//       req_id,
//       book_id,
//       page_number: parseInt(page_number),
//     });

//     if (existing) {
//       return res.status(200).json({
//         job_id: existing.job_id,
//         ok: true,
//         resumed: true,
//       });
//     }

//     /* =========================
//        ORIGINAL LOGIC STARTS
//        ========================= */

//     const originalImages = await KidPhotoModel.find(
//       { request_id: req_id },
//       { file_url: 1 },
//     );

//     if (!originalImages || originalImages.length === 0) {
//       return res.status(404).json({
//         error: "No images found for this request ID",
//         ok: false,
//       });
//     }

//     const sceneDetails = await SceneModel.findOne({
//       book_id,
//       page_number: parseInt(page_number),
//     });

//     const target_url = sceneDetails?.sceneUrl || "";
//     const swap_url = originalImages[0]?.file_url || "";

//     /* =========================
//        FIX-4 URL VALIDATION
//        ========================= */
//     if (
//       !target_url.startsWith("https://") ||
//       !swap_url.startsWith("https://")
//     ) {
//       return res.status(400).json({
//         error: "Invalid S3 image URL detected",
//         target_url,
//         swap_url,
//         ok: false,
//       });
//     }

//     console.log("target_url-----", target_url);
//     console.log("swap_url-------", swap_url);

//     // 1. Fetch & compress images
//     const targetBuffer = await fetchS3Buffer(target_url);
//     const swapBuffer = await fetchS3Buffer(swap_url);

//     const compressedTarget = await sharp(targetBuffer)
//       .jpeg({ quality: 85 })
//       .toBuffer();
//     const compressedSwap = await sharp(swapBuffer)
//       .jpeg({ quality: 85 })
//       .toBuffer();

//     // 2. Build form data
//     const form = new FormData();
//     form.append("target_image", compressedTarget, { filename: "target.jpg" });
//     form.append("swap_image", compressedSwap, { filename: "swap.jpg" });

//     // 3. Create Remaker job
//     const response = await axios.post(CREATE_JOB_URL, form, {
//       headers: {
//         ...form.getHeaders(),
//         Authorization: REMAKER_API_KEY,
//       },
//       maxBodyLength: Infinity,
//       maxContentLength: Infinity,
//       timeout: 180000,
//     });

//     const data = response.data;
//     if (data.code !== 100000) {
//       return res.status(500).json({
//         error: "Remaker job creation failed",
//         detail: data,
//       });
//     }

//     const jobId = data.result.job_id;

//     /* =========================
//        FIX-3 STEP 2: IDEMPOTENT INSERT
//        ========================= */
//     await AiKidImageModel.updateOne(
//       { req_id, book_id, page_number: parseInt(page_number) },
//       {
//         $setOnInsert: {
//           job_id: jobId,
//           status: "pending",
//           image_urls: null,
//           image_idx: 0,
//           front_cover_url: null,
//           back_cover_url: null,
//           created_at: new Date(),
//         },
//         $set: { updated_at: new Date() },
//       },
//       { upsert: true },
//     );

//     console.log("created the aikidImage Model");

//     /* =========================
//        POLLING + FULL POST PROCESS
//        ========================= */
//     (function pollWithBackoff(attempt = 0) {
//       const delay = 15000;
//       if (attempt > 20) {
//         console.error("❌ Polling stopped after max attempts");
//         return;
//       }

//       setTimeout(async () => {
//         try {
//           const result = await pollFaceSwap(jobId);

//           if (result?.code === 100000) {
//             // Download generated image
//             const response = await fetch(result.result.output_image_url[0]);
//             const initialBuffer = Buffer.from(await response.arrayBuffer());

//             // Caption
//             const scene = await SceneModel.findOne({
//               book_id,
//               page_number,
//             });

//             let captionText = scene?.scene || "Your AI story caption here";
//             captionText = captionText.replaceAll("{kid}", childName);

//             const captionedBuffer = await addCaptionWithCanva(
//               initialBuffer,
//               captionText,
//             );

//             // Upload caption image
//             const captionPath = `/tmp/${jobId}_caption.jpg`;
//             fs.writeFileSync(captionPath, captionedBuffer);

//             const captionUpload = await uploadLocalFileToS3(
//               captionPath,
//               `ai_generated_images/${jobId}_caption.jpg`,
//             );

//             // Margin image
//             const marginBuffer = await addFixedPrintMargin(
//               captionedBuffer,
//               page_number,
//             );

//             const marginPath = `/tmp/${jobId}_margin.jpg`;
//             fs.writeFileSync(marginPath, marginBuffer);

//             const marginUpload = await uploadLocalFileToS3(
//               marginPath,
//               `ai_generated_images/${jobId}_margin.jpg`,
//             );

//             // Update DB with images
//             await AiKidImageModel.updateOne(
//               { job_id: jobId },
//               {
//                 $set: {
//                   status: "completed",
//                   image_urls: [captionUpload.Location, marginUpload.Location],
//                   updated_at: new Date(),
//                 },
//               },
//             );

//             // FRONT / BACK COVER + PDF
//             const book = await StoryBookModel.findOne(
//               { _id: book_id },
//               { page_count: 1, title: 1 },
//             );

//             if (parseInt(page_number) === book.page_count) {
//               // Back cover
//               if (process.env.DEFAULT_BACK_COVER_URL) {
//                 await AiKidImageModel.updateOne(
//                   { req_id },
//                   {
//                     $set: {
//                       back_cover_url: process.env.DEFAULT_BACK_COVER_URL,
//                     },
//                   },
//                 );
//               }

//               // Upload last page
//               const lastPagePath = `/tmp/${jobId}_last.jpg`;
//               fs.writeFileSync(lastPagePath, initialBuffer);

//               const lastUpload = await uploadLocalFileToS3(
//                 lastPagePath,
//                 `storybook_pages/${jobId}_last.jpg`,
//               );

//               // Front cover
//               const frontCoverUrl = await createFrontCoverCanvas(
//                 lastUpload.Location,
//                 childName,
//                 process.env.COMPANY_LOGO_URL,
//                 book.title,
//               );

//               await AiKidImageModel.updateOne(
//                 { req_id },
//                 { $set: { front_cover_url: frontCoverUrl } },
//               );

//               // PDF generation
//               try {
//                 const pdfUrl = await generateStoryPdfForRequest(req_id);

//                 const parent = await ParentModel.findOneAndUpdate(
//                   { req_id },
//                   { $set: { pdf_url: pdfUrl } },
//                   {
//                     new: true,
//                     upsert: true, // ✅ THIS FIXES IT
//                   },
//                 );

//                 if (parent?.email && !parent.pdf_email_sent) {
//                   await sendMail(
//                     req_id,
//                     parent.name,
//                     parent.kidName,
//                     book_id,
//                     parent.email,
//                     false,
//                     true,
//                   );

//                   await ParentModel.updateOne(
//                     { req_id },
//                     { $set: { pdf_email_sent: true } },
//                   );
//                 }
//               } catch (err) {
//                 console.error("PDF / Email error:", err);
//               }
//             }

//             // Cleanup
//             fs.unlinkSync(captionPath);
//             fs.unlinkSync(marginPath);
//             return;
//           }

//           pollWithBackoff(attempt + 1);
//         } catch (err) {
//           console.error("Polling error:", err);
//           pollWithBackoff(attempt + 1);
//         }
//       }, delay);
//     })();

//     return res.status(200).json({ job_id: jobId, ok: true });
//   } catch (error) {
//     console.error("Error generating image:", error);
//     res.status(500).json({ error: "Failed to generate image", ok: false });
//   }
// };

/** upload a local file to S3 (same approach as storeOriginalImageToS3) */
export async function uploadLocalFileToS3(
  localFilePath,
  s3Key,
  contentType = "image/jpeg",
) {
  const fileContent = fs.readFileSync(localFilePath);

  const params = {
    Bucket: process.env.PROD_AWS_S3_BUCKET_NAME,
    Key: s3Key,
    Body: fileContent,
    ContentType: contentType,
  };
  const uploadResult = await s3.upload(params).promise();
  return uploadResult; // { Location, Key, ... }
}

async function pollFaceSwap(jobId) {
  const resp = await fetch(
    `https://developer.remaker.ai/api/remaker/v1/face-swap/${jobId}`,
    {
      headers: {
        Authorization: REMAKER_API_KEY,
        accept: "application/json",
      },
    },
  );
  const data = await resp.json();

  return data;
}

export const checkGenerationStatus = async (req, res) => {
  try {
    const { page_number, book_id, job_id } = req.query;

    const aiImageDetail = await AiKidImageModel.findOne({ job_id });

    if (!aiImageDetail) {
      return res.status(404).json({
        error: "Job not found",
        ok: false,
      });
    }

    if (aiImageDetail.status === "completed") {
      const sceneDetails = await SceneModel.findOne({
        book_id,
        page_number,
      });

      const book = await StoryBookModel.findOne(
        { _id: book_id },
        { page_count: 1 },
      );

      const next = page_number < book.page_count;

      // ✅ PURE RESPONSE — NO EMAIL, NO SIDE EFFECT
      return res.status(200).json({
        ...aiImageDetail.toObject(),
        scene: sceneDetails?.scene || "",
        next,
        ok: true,
      });
    }

    // still processing
    return res.status(200).json({
      status: aiImageDetail.status,
      image_urls: aiImageDetail.image_urls,
      ok: true,
    });
  } catch (error) {
    console.log("Error checking generation status:", error);
    return res
      .status(500)
      .json({ error: "Failed to check generation status", ok: false });
  }
};

export const updatePageImage = async (req, res) => {
  try {
    const { req_id, job_id, image_id } = req.body;

    await AiKidImageModel.updateOne(
      { req_id, job_id },
      {
        $set: {
          image_idx: image_id,
        },
      },
    );
    res
      .status(200)
      .json({ message: "Page image updated successfully", ok: true });
  } catch (error) {
    console.log("Error updating page image:", error);
    res.status(500).json({ error: "Failed to update page image", ok: false });
  }
};

export const createParentAndSendMail = async (req, res) => {
  try {
    const { name, email, kidName, req_id, book_id, notify = false } = req.body;
    // console.log("notify 1:", notify);
    // 1. Save parent info to DB
    const parentDeatil = await ParentModel.findOneAndUpdate(
      { req_id }, // filter
      { $setOnInsert: { name, email, kidName, req_id, notify } }, // only insert if not found
      { upsert: true, new: true }, // new: true returns the document
    );

    // if (!notify) {
    //   await sendMail(req_id, name, kidName, book_id, email, true);
    // }
    if (notify && !parentDeatil.preview_email_sent) {
      await sendMail(req_id, name, kidName, book_id, email, true);

      await ParentModel.updateOne(
        { req_id },
        { $set: { preview_email_sent: true } },
      );
    }

    res
      .status(200)
      .json({ message: "Parent saved and email sent successfully" });
  } catch (error) {
    console.error("Error:", error);
    res
      .status(500)
      .json({ message: "Failed to process request", error: error.message });
  }
};

const sendMail = async (
  req_id,
  name,
  kidName,
  book_id,
  email,
  emailStatus = false,
  pdfReady = false,
  pdfUrl = null, // ✅ NEW
) => {
  // const previewUrl = `https://storybookg.netlify.app/preview?request_id=${req_id}&name=${kidName}&book_id=${book_id}&email=${emailStatus}`;
  const previewUrl = `http://localhost:5173/preview?request_id=${req_id}&name=${kidName}&book_id=${book_id}&email=${emailStatus}`;
  let parent = await ParentModel.findOne({ req_id });
  pdfUrl = parent?.pdf_url || null;
  pdfReady = !!pdfUrl;
  const emailHtml = `
      <p>Dear ${name},</p>
      <p>${
        pdfReady
          ? `${kidName}'s final storybook PDF is now ready! 🎉`
          : `We are crafting ${kidName}'s magical storybook!`
      }</p>

      ${
        pdfReady
          ? `
            <p><strong>Download Full PDF:</strong></p>
            <a href="${pdfUrl}" style="
              display:inline-block;padding:12px 20px;
              background-color:#28A745;color:white;
              text-decoration:none;font-weight:bold;border-radius:4px;
              margin:10px 0;">Download PDF</a>
            `
          : `
            <p><strong>Preview Book:</strong></p>
            <a href="${previewUrl}" style="
              display:inline-block;padding:12px 20px;
              background-color:#007BFF;color:white;
              text-decoration:none;font-weight:bold;border-radius:4px;
              margin:10px 0;">Preview Story Book</a>
          `
      }

      <p>Warm regards,<br/>StoryBook Team</p>
  `;

  const msg = {
    to: email,
    from: process.env.MAIL_SENDER,
    subject: pdfReady
      ? `${kidName}'s StoryBook PDF is Ready! 🎉`
      : `${kidName}'s StoryBook Preview is Ready!`,
    html: emailHtml,
  };

  await sgMail.send(msg);
  console.log("Email sent ✔");
};

// const sendMail = async (
//   req_id,
//   name,
//   kidName,
//   book_id,
//   email,
//   emailStatus = false
// ) => {
//   try {
//     // 2. Generate preview URL
//     const previewUrl = `https://storybookg.netlify.app/preview?request_id=${req_id}&name=${kidName}&book_id=${book_id}&email=${emailStatus}`;
//     // 3. Create nodemailer transporter
//     const transporter = nodemailer.createTransport({
//       service: "gmail",
//       auth: {
//         user: process.env.MAIL_USER,
//         pass: process.env.MAIL_PASS,
//       },
//     });

//     // 4. Compose HTML email
//     const emailHtml = `
//       <p>Dear ${name},</p>
//       <p>
//         Congratulations on taking the first step in crafting ${kidName}'s magical book with Storybook!
//         Unlike any other personalized books, they're not just a name on a page;
//         they're the star, brought to life through personalized illustrations. 🌈📖
//       </p>
//       <p><strong>${kidName}'s Book Preview:</strong></p>
//       <p>Your magical creation is underway! Feel free to refine it and show it to others by clicking the button below.</p>
//       <a href="${previewUrl}" style="
//         display: inline-block;
//         padding: 12px 20px;
//         background-color: #007BFF;
//         color: white;
//         text-decoration: none;
//         font-weight: bold;
//         border-radius: 4px;
//         margin: 20px 0;
//       ">Refine ${kidName}'s Book</a>
//       <p><strong>Questions?</strong></p>
//       <p>If you have any questions or need further assistance, simply reply to this email.
//       We're here to help you craft a treasured keepsake for ${kidName}.</p>
//       <p>Warmest regards,<br>The StoryBook Team</p>
//     `;

//     // 5. Send email
//     await transporter.sendMail({
//       from: `"Storybook" <${process.env.MAIL_USER}>`,
//       to: email,
//       subject: `Preview and Refine ${kidName}'s Magical Book!`,
//       html: emailHtml,
//     });
//   } catch (error) {
//     console.error("Error sending email:", error);
//     throw error;
//   }
// };

// const sendMail = async (
//   req_id,
//   name,
//   kidName,
//   book_id,
//   email,
//   emailStatus = false,
//   pdfReady = false
// ) => {
//   const parentDetails = await ParentModel.findOne({ req_id });
//   const previewUrl = `https://storybookg.netlify.app/preview?request_id=${req_id}&name=${kidName}&book_id=${book_id}&email=${emailStatus}`;
//   // const previewUrl = `http://127.0.0.1:5173/preview?request_id=${req_id}&name=${kidName}&book_id=${book_id}&email=${emailStatus}`;
//   const pdfUrl = parentDetails?.pdf_url || null;
//   console.log(pdfUrl);
//   // const msg = {
//   //   to: email,
//   //   from: process.env.MAIL_SENDER, // Verified sender in SendGrid
//   //   subject: `Preview and Refine ${kidName}'s Magical Book!`,
//   //   html: `
//   //     <p>Dear ${name},</p>
//   //     <p>Congratulations on crafting ${kidName}'s magical book!</p>
//   //     <p><strong>${kidName}'s Book Preview:</strong></p>
//   //     <p>Click below to view and refine the book:</p>
//   //     <a href="${previewUrl}" style="
//   //       display:inline-block;padding:12px 20px;
//   //       background-color:#007BFF;color:white;
//   //       text-decoration:none;font-weight:bold;border-radius:4px;
//   //       margin:20px 0;">Refine ${kidName}'s Book</a>
//   //     <p>If you have questions, just reply to this email.</p>
//   //     <p>Warm regards,<br/>StoryBook Team</p>
//   //   `,
//   // };
//   const emailHtml = `
//       <p>Dear ${name},</p>
//       <p>Congratulations! ${kidName}'s magical storybook is ready 🎉</p>

//       <p><strong>View Preview:</strong></p>
//       <a href="${previewUrl}" style="
//         display:inline-block;padding:12px 20px;
//         background-color:#007BFF;color:white;
//         text-decoration:none;font-weight:bold;border-radius:4px;
//         margin:10px 0;">Preview Story Book</a>

//       ${
//         pdfUrl
//           ? `
//         <p><strong>Download Full PDF:</strong></p>
//         <a href="${pdfUrl}" style="
//           display:inline-block;padding:12px 20px;
//           background-color:#28A745;color:white;
//           text-decoration:none;font-weight:bold;border-radius:4px;
//           margin:10px 0;">Download PDF</a>
//         `
//           : `<p><i>PDF processing... you will get it soon!</i></p>`
//       }

//       <p>You can refine any page and make this book even more magical ✨</p>
//       <p>Warm regards,<br/>StoryBook Team</p>
//     `;
//   const msg = {
//     to: email,
//     from: process.env.MAIL_SENDER, // verified Sender Identity
//     subject: `${kidName}'s Magical Book is Ready!`,
//     html: emailHtml,
//   };
//   await sgMail
//     .send(msg)
//     .then(() => console.log("Mail Sent!"))
//     .catch((err) => {
//       console.log("SendGrid Error:", err.response?.body || err.message);
//     });

//   // await sgMail.send(msg);
//   // console.log("Preview email sent to:", email);
// };
