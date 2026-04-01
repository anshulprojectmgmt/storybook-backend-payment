import AWS from "aws-sdk";
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import sharp from "sharp";
import { createCanvas, loadImage } from "@napi-rs/canvas";

import KidPhotoModel from "../models/kidPhotoModel.js";
import SceneModel from "../models/sceneModel.js";
import StoryBookModel from "../models/StoryBookModel.js";
import AiKidImageModel from "../models/aiKidImageModel.js";
import ParentModel from "../models/parentModel.js";
import axios from "axios";
import FormData from "form-data";
import sgMail from "@sendgrid/mail";
import { createFrontCoverCanvas } from "../helper/createFrontCoverCanvas.js";
import { addFixedPrintMargin } from "../helper/addFixedPrintMargin.js";
import { generateStoryPdfForRequest } from "../helper/pdfService.js";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY?.trim();
const MAIL_SENDER = process.env.MAIL_SENDER?.trim();

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

const S3_REQUEST_TIMEOUT_MS = 120000;
const S3_CONNECT_TIMEOUT_MS = 15000;

const s3 = new AWS.S3({
  accessKeyId: process.env.PROD_AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.PROD_AWS_SECRET_ACCESS_KEY,
  region: process.env.PROD_AWS_REGION,
  maxRetries: 5,
  httpOptions: {
    timeout: S3_REQUEST_TIMEOUT_MS,
    connectTimeout: S3_CONNECT_TIMEOUT_MS,
  },
});

const REMAKER_API_KEY = process.env.REMAKER_API_KEY;
const CREATE_JOB_URL =
  "https://developer.remaker.ai/api/remaker/v1/face-swap/create-job";
const FREE_PREVIEW_PAGE_COUNT = 2;
const REQUIRED_SOURCE_IMAGE_COUNT = 2;
const MAX_POLL_ATTEMPTS = 80;
const POLL_DELAY_MS = 3000;
const PREVIEW_IMAGE_MAX_WIDTH = 1400;
const PREVIEW_IMAGE_QUALITY = 78;
const AUTO_FINAL_PDF_DELAY_MS = 3 * 60 * 1000;
const finalPdfTimers = new Map();

export async function fetchS3Buffer(s3Url) {
  try {
    const url = new URL(s3Url);

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
    console.error("S3 fetch failed:", s3Url, err.message);
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupLocalFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function getImageOptions(doc) {
  if (Array.isArray(doc?.image_options) && doc.image_options.length > 0) {
    return doc.image_options.map((option, index) => ({
      option_idx:
        typeof option.option_idx === "number" ? option.option_idx : index,
      job_id: option.job_id || null,
      preview_url: option.preview_url || option.print_url || null,
      raw_url: option.raw_url || option.preview_url || option.print_url || null,
      print_url: option.print_url || option.preview_url || null,
      source_image_url: option.source_image_url || null,
    }));
  }

  if (Array.isArray(doc?.image_urls) && doc.image_urls.length > 0) {
    return [
      {
        option_idx: 0,
        job_id: doc.job_id || null,
        preview_url: doc.image_urls[0] || null,
        raw_url: doc.image_urls[0] || doc.image_urls[1] || null,
        print_url: doc.image_urls[1] || doc.image_urls[0] || null,
        source_image_url: null,
      },
    ];
  }

  return [];
}

function getSelectedOption(doc) {
  const options = getImageOptions(doc);
  if (!options.length) {
    return null;
  }

  const safeIndex =
    typeof doc?.image_idx === "number" &&
    doc.image_idx >= 0 &&
    doc.image_idx < options.length
      ? doc.image_idx
      : 0;

  return options[safeIndex] || options[0];
}

function buildStatusPayload(doc) {
  const options = getImageOptions(doc);
  const selectedOption = getSelectedOption(doc);
  const safeIndex =
    typeof doc?.image_idx === "number" &&
    doc.image_idx >= 0 &&
    doc.image_idx < options.length
      ? doc.image_idx
      : 0;

  return {
    ...doc.toObject(),
    image_idx: safeIndex,
    image_urls: options.map(
      (option) => option.preview_url || option.print_url || null,
    ),
    image_options: options,
    selected_preview_url:
      selectedOption?.preview_url || selectedOption?.print_url || null,
    selected_print_url:
      selectedOption?.print_url || selectedOption?.preview_url || null,
  };
}

function clearAutoPdfTimer(req_id) {
  const timer = finalPdfTimers.get(req_id);
  if (timer) {
    clearTimeout(timer);
    finalPdfTimers.delete(req_id);
  }
}

function getEffectiveFinalPdfStatus(parent) {
  if (parent?.pdf_url) {
    return "ready";
  }

  return parent?.final_pdf_status || "not_ready";
}

function getFinalPdfState(parent) {
  return {
    final_pdf_status: getEffectiveFinalPdfStatus(parent),
    auto_generate_pdf_at: parent?.auto_generate_pdf_at || null,
    final_book_ready_at: parent?.final_book_ready_at || null,
    pdf_url: parent?.pdf_url || null,
    pdf_ready: Boolean(parent?.pdf_url),
  };
}

async function createFaceSwapJob(targetBuffer, swapBuffer) {
  const form = new FormData();
  form.append("target_image", targetBuffer, { filename: "target.jpg" });
  form.append("swap_image", swapBuffer, { filename: "swap.jpg" });

  const response = await axios.post(CREATE_JOB_URL, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: REMAKER_API_KEY,
    },
    timeout: 180000,
    maxBodyLength: Infinity,
  });

  if (response.data.code !== 100000) {
    throw new Error("Remaker job creation failed");
  }

  return response.data.result.job_id;
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

  return resp.json();
}

async function waitForFaceSwap(jobId) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const result = await pollFaceSwap(jobId);

    if (result?.code === 100000) {
      return result;
    }

    await sleep(POLL_DELAY_MS);
  }

  throw new Error(`Polling timed out for job ${jobId}`);
}

async function uploadGeneratedOption({
  jobId,
  pageNum,
  captionText,
  sourceImageUrl,
}) {
  const result = await waitForFaceSwap(jobId);
  const outputUrl = result?.result?.output_image_url?.[0];

  if (!outputUrl) {
    throw new Error(`No generated image returned for job ${jobId}`);
  }

  const imageResponse = await fetch(outputUrl);
  const baseBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const rawBuffer = await sharp(baseBuffer)
    .jpeg({
      quality: 88,
      mozjpeg: true,
    })
    .toBuffer();
  const captionedBuffer = await addCaptionWithCanva(rawBuffer, captionText);
  const previewBuffer = await sharp(captionedBuffer)
    .resize({
      width: PREVIEW_IMAGE_MAX_WIDTH,
      withoutEnlargement: true,
    })
    .jpeg({
      quality: PREVIEW_IMAGE_QUALITY,
      mozjpeg: true,
    })
    .toBuffer();
  const printBuffer = await addFixedPrintMargin(captionedBuffer, pageNum);

  const rawPath = `/tmp/${jobId}_raw.jpg`;
  const previewPath = `/tmp/${jobId}_preview.jpg`;
  const printPath = `/tmp/${jobId}_print.jpg`;

  try {
    fs.writeFileSync(rawPath, rawBuffer);
    fs.writeFileSync(previewPath, previewBuffer);
    fs.writeFileSync(printPath, printBuffer);

    const [rawUpload, previewUpload, printUpload] = await Promise.all([
      uploadLocalFileToS3(rawPath, `ai_generated_images/${jobId}_raw.jpg`),
      uploadLocalFileToS3(previewPath, `ai_generated_images/${jobId}_preview.jpg`),
      uploadLocalFileToS3(printPath, `ai_generated_images/${jobId}_print.jpg`),
    ]);

    return {
      job_id: jobId,
      raw_url: rawUpload.Location,
      preview_url: previewUpload.Location,
      print_url: printUpload.Location,
      source_image_url: sourceImageUrl,
    };
  } finally {
    cleanupLocalFile(rawPath);
    cleanupLocalFile(previewPath);
    cleanupLocalFile(printPath);
  }
}

async function prepareBookAssetsForFinalSelection({
  req_id,
  book_id,
  childName,
  refreshFrontCover = false,
}) {
  const effectiveBookId =
    book_id ||
    (
      await AiKidImageModel.findOne({ req_id }, { book_id: 1 }).lean()
    )?.book_id;

  if (!effectiveBookId) {
    return null;
  }

  const [parent, book, pages] = await Promise.all([
    ParentModel.findOne({ req_id }),
    StoryBookModel.findById(effectiveBookId, { page_count: 1, title: 1 }),
    AiKidImageModel.find(
      { req_id, book_id: effectiveBookId },
      {
        page_number: 1,
        status: 1,
        image_urls: 1,
        image_options: 1,
        image_idx: 1,
        front_cover_url: 1,
        back_cover_url: 1,
      },
    ).sort({ page_number: 1 }),
  ]);

  if (!parent || parent.payment !== "paid" || !book) {
    return null;
  }

  const completedPages = pages.filter(
    (page) => page.status === "completed" && getImageOptions(page).length > 0,
  );

  if (completedPages.length < book.page_count) {
    return null;
  }

  const lastPage = completedPages[completedPages.length - 1];
  const lastSelectedOption = getSelectedOption(lastPage);
  const coverSourceUrl =
    lastSelectedOption?.raw_url ||
    lastSelectedOption?.preview_url ||
    lastSelectedOption?.print_url;

  if (!coverSourceUrl) {
    return null;
  }

  const existingFrontCover =
    pages.find((page) => page.front_cover_url)?.front_cover_url || null;
  const existingBackCover =
    pages.find((page) => page.back_cover_url)?.back_cover_url || null;

  const frontCoverUrl =
    !refreshFrontCover && existingFrontCover
      ? existingFrontCover
      : await createFrontCoverCanvas(
          coverSourceUrl,
          childName || parent.kidName || "Your child",
          process.env.COMPANY_LOGO_URL,
          book.title,
        );

  const backCoverUrl =
    existingBackCover || process.env.DEFAULT_BACK_COVER_URL || null;

  const coverUpdate = {
    front_cover_url: frontCoverUrl,
    updated_at: new Date(),
  };

  if (backCoverUrl) {
    coverUpdate.back_cover_url = backCoverUrl;
  }

  await AiKidImageModel.updateMany(
    { req_id, book_id: effectiveBookId },
    { $set: coverUpdate },
  );

  return {
    parent,
    book,
    book_id: effectiveBookId,
    front_cover_url: frontCoverUrl,
    back_cover_url: backCoverUrl,
  };
}

function scheduleAutoFinalPdfGeneration({
  req_id,
  book_id,
  childName,
  autoGenerateAt,
}) {
  clearAutoPdfTimer(req_id);

  const triggerAt = new Date(autoGenerateAt).getTime();
  if (!Number.isFinite(triggerAt)) {
    return;
  }

  const delay = Math.max(0, triggerAt - Date.now());
  const timer = setTimeout(() => {
    void generateFinalPdfForSelections({
      req_id,
      book_id,
      childName,
      trigger: "auto",
    }).catch((error) => {
      console.error("Automatic final PDF generation failed:", error);
    });
  }, delay);

  finalPdfTimers.set(req_id, timer);
}

async function prepareBookForFinalSelectionIfReady({
  req_id,
  book_id,
  childName,
  refreshFrontCover = false,
}) {
  const preparedBook = await prepareBookAssetsForFinalSelection({
    req_id,
    book_id,
    childName,
    refreshFrontCover,
  });

  if (!preparedBook) {
    return null;
  }

  const currentStatus = getEffectiveFinalPdfStatus(preparedBook.parent);
  if (currentStatus === "ready" || currentStatus === "generating") {
    if (currentStatus === "ready") {
      clearAutoPdfTimer(req_id);
    }

    return {
      book_ready: true,
      ...getFinalPdfState(preparedBook.parent),
    };
  }

  const autoGenerateAt =
    preparedBook.parent?.auto_generate_pdf_at &&
    currentStatus === "selection_ready"
      ? preparedBook.parent.auto_generate_pdf_at
      : new Date(Date.now() + AUTO_FINAL_PDF_DELAY_MS);

  const updatedParent = await ParentModel.findOneAndUpdate(
    { req_id },
    {
      $set: {
        final_pdf_status: "selection_ready",
        auto_generate_pdf_at: autoGenerateAt,
        final_book_ready_at:
          preparedBook.parent?.final_book_ready_at || new Date(),
      },
    },
    { new: true },
  );

  scheduleAutoFinalPdfGeneration({
    req_id,
    book_id: preparedBook.book_id,
    childName: childName || preparedBook.parent?.kidName || "Your child",
    autoGenerateAt,
  });

  return {
    book_ready: true,
    ...getFinalPdfState(updatedParent),
  };
}

async function generateFinalPdfForSelections({
  req_id,
  book_id,
  childName,
  trigger = "manual",
}) {
  const parent = await ParentModel.findOne({ req_id });

  if (!parent || parent.payment !== "paid") {
    return null;
  }

  if (parent.pdf_url) {
    clearAutoPdfTimer(req_id);
    return {
      book_ready: true,
      ...getFinalPdfState(parent),
    };
  }

  if (getEffectiveFinalPdfStatus(parent) === "generating") {
    return {
      book_ready: true,
      ...getFinalPdfState(parent),
    };
  }

  clearAutoPdfTimer(req_id);

  await ParentModel.updateOne(
    { req_id },
    {
      $set: {
        final_pdf_status: "generating",
        auto_generate_pdf_at: null,
      },
    },
  );

  const preparedBook = await prepareBookAssetsForFinalSelection({
    req_id,
    book_id,
    childName,
  });

  if (!preparedBook) {
    const resetParent = await ParentModel.findOneAndUpdate(
      { req_id },
      { $set: { final_pdf_status: "failed" } },
      { new: true },
    );

    return {
      book_ready: false,
      trigger,
      ...getFinalPdfState(resetParent),
    };
  }

  try {
    const pdfUrl = await generateStoryPdfForRequest(req_id);

    const updatedParent = await ParentModel.findOneAndUpdate(
      { req_id },
      {
        $set: {
          pdf_url: pdfUrl,
          final_pdf_status: "ready",
          auto_generate_pdf_at: null,
          final_book_ready_at:
            preparedBook.parent?.final_book_ready_at || new Date(),
        },
      },
      { new: true },
    );

    if (updatedParent?.email && !updatedParent.pdf_email_sent) {
      try {
        await sendMail(
          req_id,
          updatedParent.name,
          updatedParent.kidName,
          preparedBook.book_id,
          updatedParent.email,
          false,
          true,
          pdfUrl,
        );

        await ParentModel.updateOne(
          { req_id },
          { $set: { pdf_email_sent: true } },
        );
      } catch (error) {
        console.error("Final PDF email failed:", getSendGridErrorMessage(error));
      }
    }

    return {
      book_ready: true,
      trigger,
      ...getFinalPdfState(updatedParent),
    };
  } catch (error) {
    console.error("Final PDF generation failed:", error);

    const failedParent = await ParentModel.findOneAndUpdate(
      { req_id },
      { $set: { final_pdf_status: "failed" } },
      { new: true },
    );

    return {
      book_ready: true,
      trigger,
      ...getFinalPdfState(failedParent),
    };
  }
}

export async function maybeGenerateFinalPdfIfDue(req_id) {
  if (!req_id) {
    return null;
  }

  const parent = await ParentModel.findOne({ req_id });
  if (!parent || parent.payment !== "paid") {
    return parent;
  }

  if (parent.pdf_url) {
    clearAutoPdfTimer(req_id);
    return parent;
  }

  if (
    getEffectiveFinalPdfStatus(parent) === "selection_ready" &&
    parent.auto_generate_pdf_at
  ) {
    const dueAt = new Date(parent.auto_generate_pdf_at).getTime();

    if (Number.isFinite(dueAt)) {
      if (dueAt <= Date.now()) {
        await generateFinalPdfForSelections({ req_id, trigger: "auto" });
        return ParentModel.findOne({ req_id });
      }

      scheduleAutoFinalPdfGeneration({
        req_id,
        autoGenerateAt: parent.auto_generate_pdf_at,
      });
    }
  }

  return parent;
}

async function processGeneratedPage({
  req_id,
  book_id,
  pageNum,
  childName,
  captionText,
  jobEntries,
}) {
  const settledResults = await Promise.allSettled(
    jobEntries.map(async (entry) =>
      uploadGeneratedOption({
        jobId: entry.job_id,
        pageNum,
        captionText,
        sourceImageUrl: entry.source_image_url,
      }),
    ),
  );

  const successfulOptions = settledResults
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .map((option, index) => ({
      ...option,
      option_idx: index,
    }));

  if (!successfulOptions.length) {
    await AiKidImageModel.updateOne(
      { req_id, book_id, page_number: pageNum },
      {
        $set: {
          status: "failed",
          updated_at: new Date(),
        },
      },
    );
    return;
  }

  const existingDoc = await AiKidImageModel.findOne({
    req_id,
    book_id,
    page_number: pageNum,
  });

  const safeIndex =
    typeof existingDoc?.image_idx === "number" &&
    existingDoc.image_idx >= 0 &&
    existingDoc.image_idx < successfulOptions.length
      ? existingDoc.image_idx
      : 0;

  const selectedOption = successfulOptions[safeIndex] || successfulOptions[0];

  await AiKidImageModel.updateOne(
    { req_id, book_id, page_number: pageNum },
    {
      $set: {
        status: "completed",
        image_options: successfulOptions,
        image_idx: safeIndex,
        image_urls: [
          selectedOption.preview_url || selectedOption.print_url,
          selectedOption.print_url || selectedOption.preview_url,
        ],
        updated_at: new Date(),
      },
    },
  );

  await prepareBookForFinalSelectionIfReady({
    req_id,
    book_id,
    childName,
    refreshFrontCover: pageNum === Number(existingDoc?.page_number),
  });
}

function getFrontendBaseUrl() {
  return (process.env.FRONTEND_URL || "http://localhost:5173").replace(
    /\/+$/,
    "",
  );
}

function getSendGridErrorMessage(error) {
  const sendGridErrors = error?.response?.body?.errors;

  if (Array.isArray(sendGridErrors) && sendGridErrors.length > 0) {
    return sendGridErrors
      .map((item) => item?.message || item?.field || "Unknown SendGrid error")
      .join("; ");
  }

  return error?.message || "Unknown email delivery error";
}

export const storeOriginalImageToS3 = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded", ok: false });
    }

    const filePath = req.file.path;
    const fileContent = fs.readFileSync(filePath);

    const params = {
      Bucket: process.env.PROD_AWS_S3_BUCKET_NAME,
      Key: `original_images/${Date.now()}_${req.file.originalname}`,
      Body: fileContent,
      ContentType: req.file.mimetype,
    };

    const uploadResult = await s3.upload(params).promise();
    cleanupLocalFile(filePath);

    return res.status(200).json({
      file_url: uploadResult.Location,
      upload_url: uploadResult.Key,
      ok: true,
    });
  } catch (error) {
    console.error("Error uploading to S3:", error);
    return res.status(500).json({ error: "Failed to upload file", ok: false });
  }
};

export const add_photoToDB = async (req, res) => {
  try {
    const { file_url, file_name, request_id } = req.body;

    const result = await KidPhotoModel.create({
      file_url,
      file_name,
      request_id,
    });

    return res.status(200).json({
      message: "Photo added successfully",
      photo_id: result._id,
      ok: true,
    });
  } catch (error) {
    console.error("Error adding photo to DB:", error);
    return res.status(500).json({ error: "Failed to add photo", ok: false });
  }
};

async function addCaptionWithCanva(imageBuffer, captionText) {
  const img = sharp(imageBuffer);
  const { width, height } = await img.metadata();

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const base = await loadImage(imageBuffer);
  ctx.drawImage(base, 0, 0, width, height);

  const barHeight = Math.floor(height * 0.2);

  const cloud = ctx.createLinearGradient(0, height - barHeight, 0, height);
  cloud.addColorStop(0, "rgba(0, 0, 0, 0.40)");
  cloud.addColorStop(1, "rgba(0, 0, 0, 0.80)");
  ctx.fillStyle = cloud;
  ctx.fillRect(0, height - barHeight, width, barHeight);

  let fontSize = Math.floor(barHeight * 0.24);
  ctx.font = `${fontSize}px Sans-Serif`;

  function wrapText(text) {
    const words = text.split(" ");
    let line = "";
    const lines = [];

    for (const word of words) {
      const test = `${line}${word} `;
      if (ctx.measureText(test).width > width * 0.83) {
        lines.push(line.trim());
        line = "";
      }
      line += `${word} `;
    }

    lines.push(line.trim());
    return lines;
  }

  let lines = wrapText(captionText);
  let lineHeight = fontSize * 1.35;

  while (lines.length * lineHeight > barHeight * 0.92) {
    fontSize -= 2;
    ctx.font = `${fontSize}px Sans-Serif`;
    lineHeight = fontSize * 1.35;
    lines = wrapText(captionText);
  }

  const centerY =
    height - barHeight / 2 - ((lines.length - 1) * lineHeight) / 2 - 10;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0.0, "#A8C8FF");
  gradient.addColorStop(0.35, "#7BB6FF");
  gradient.addColorStop(0.7, "#B8A8FF");
  gradient.addColorStop(1.0, "#E0DDFF");

  lines.forEach((line, index) => {
    const y = centerY + index * lineHeight;

    ctx.save();
    ctx.shadowColor = "rgba(180, 210, 255, 1)";
    ctx.shadowBlur = fontSize * 2.4;
    ctx.fillStyle = gradient;
    ctx.fillText(line, width / 2, y);
    ctx.restore();

    ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
    ctx.lineWidth = fontSize * 0.12;
    ctx.strokeText(line, width / 2, y);

    ctx.fillStyle = gradient;
    ctx.fillText(line, width / 2, y);
  });

  return canvas.toBuffer("image/jpeg");
}

export const getGeneratedImage = async (req, res) => {
  const { req_id, page_number, book_id, childName: frontendName } = req.query;

  try {
    const pageNum = Number.parseInt(page_number, 10);

    if (Number.isNaN(pageNum)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid page number",
      });
    }

    if (pageNum > FREE_PREVIEW_PAGE_COUNT) {
      const parent = await ParentModel.findOne({ req_id });
      if (!parent || parent.payment !== "paid") {
        return res.status(403).json({
          ok: false,
          locked: true,
          message: "Payment required to unlock full book",
        });
      }
    }

    const parent = await ParentModel.findOne({ req_id });
    const childName = frontendName || parent?.kidName || "Your child";

    const existing = await AiKidImageModel.findOne({
      req_id,
      book_id,
      page_number: pageNum,
    });

    if (existing) {
      return res.status(200).json({
        job_id: existing.job_id,
        job_ids:
          Array.isArray(existing.job_ids) && existing.job_ids.length > 0
            ? existing.job_ids
            : [existing.job_id],
        ok: true,
        resumed: true,
      });
    }

    const [originalImages, sceneDetails] = await Promise.all([
      KidPhotoModel.find(
        { request_id: req_id },
        { file_url: 1, dateTaken: 1 },
      ).sort({ dateTaken: 1, _id: 1 }),
      SceneModel.findOne({
        book_id,
        page_number: pageNum,
      }),
    ]);

    if (!originalImages?.length) {
      return res.status(404).json({
        ok: false,
        error: "No source images found",
      });
    }

    if (!sceneDetails?.sceneUrl?.startsWith("https://")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid scene URL",
      });
    }

    const sourcePhotos = originalImages
      .filter((photo) => photo.file_url?.startsWith("https://"))
      .slice(0, REQUIRED_SOURCE_IMAGE_COUNT);

    if (!sourcePhotos.length) {
      return res.status(400).json({
        ok: false,
        error: "No valid source images found",
      });
    }

    const targetBuffer = await fetchS3Buffer(sceneDetails.sceneUrl);
    const compressedTargetBuffer = await sharp(targetBuffer)
      .jpeg({ quality: 85 })
      .toBuffer();

    const jobEntries = await Promise.all(
      sourcePhotos.map(async (photo) => {
        const swapBuffer = await fetchS3Buffer(photo.file_url);
        const compressedSwapBuffer = await sharp(swapBuffer)
          .jpeg({ quality: 85 })
          .toBuffer();

        const jobId = await createFaceSwapJob(
          compressedTargetBuffer,
          compressedSwapBuffer,
        );

        return {
          job_id: jobId,
          source_image_url: photo.file_url,
        };
      }),
    );

    const jobIds = jobEntries.map((entry) => entry.job_id);

    await AiKidImageModel.updateOne(
      { req_id, book_id, page_number: pageNum },
      {
        $setOnInsert: {
          job_id: jobIds[0],
          job_ids: jobIds,
          status: "pending",
          image_urls: null,
          image_options: [],
          image_idx: 0,
          front_cover_url: null,
          back_cover_url: null,
          created_at: new Date(),
        },
        $set: {
          updated_at: new Date(),
        },
      },
      { upsert: true },
    );

    const captionText =
      sceneDetails.scene?.replaceAll("{kid}", childName) || "Your AI story";

    void processGeneratedPage({
      req_id,
      book_id,
      pageNum,
      childName,
      captionText,
      jobEntries,
    }).catch(async (error) => {
      console.error("Page generation processing failed:", error);
      await AiKidImageModel.updateOne(
        { req_id, book_id, page_number: pageNum },
        {
          $set: {
            status: "failed",
            updated_at: new Date(),
          },
        },
      );
    });

    return res.status(200).json({
      ok: true,
      job_id: jobIds[0],
      job_ids: jobIds,
    });
  } catch (err) {
    console.error("getGeneratedImage error:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to generate image",
    });
  }
};

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

  return s3.upload(params).promise();
}

export const checkGenerationStatus = async (req, res) => {
  try {
    const { req_id, page_number, book_id, job_id } = req.query;

    const aiImageDetail =
      (job_id && (await AiKidImageModel.findOne({ job_id }))) ||
      (await AiKidImageModel.findOne({
        req_id,
        book_id,
        page_number: Number.parseInt(page_number, 10),
      }));

    if (!aiImageDetail) {
      return res.status(404).json({
        error: "Job not found",
        ok: false,
      });
    }

    if (aiImageDetail.status === "completed") {
      const [sceneDetails, book] = await Promise.all([
        SceneModel.findOne({
          book_id,
          page_number,
        }),
        StoryBookModel.findById(book_id, { page_count: 1 }),
      ]);

      const next = Number(page_number) < Number(book?.page_count || 0);

      return res.status(200).json({
        ...buildStatusPayload(aiImageDetail),
        scene: sceneDetails?.scene || "",
        next,
        ok: true,
      });
    }

    return res.status(200).json({
      status: aiImageDetail.status,
      image_urls: getImageOptions(aiImageDetail).map(
        (option) => option.preview_url || option.print_url || null,
      ),
      image_options: getImageOptions(aiImageDetail),
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

    const pageDoc = await AiKidImageModel.findOne({ req_id, job_id });
    if (!pageDoc) {
      return res.status(404).json({
        ok: false,
        error: "Page not found",
      });
    }

    const options = getImageOptions(pageDoc);
    const safeIndex =
      options.length > 0
        ? Math.max(
            0,
            Math.min(Number.parseInt(image_id, 10) || 0, options.length - 1),
          )
        : 0;

    const selectedOption = options[safeIndex] || null;

    await AiKidImageModel.updateOne(
      { req_id, job_id },
      {
        $set: {
          image_idx: safeIndex,
          image_urls: selectedOption
            ? [
                selectedOption.preview_url || selectedOption.print_url,
                selectedOption.print_url || selectedOption.preview_url,
              ]
            : pageDoc.image_urls,
          updated_at: new Date(),
        },
      },
    );

    const book = await StoryBookModel.findById(pageDoc.book_id, {
      page_count: 1,
    });

    const finalBookState = await prepareBookForFinalSelectionIfReady({
      req_id,
      book_id: pageDoc.book_id,
      childName: null,
      refreshFrontCover: pageDoc.page_number === Number(book?.page_count),
    });

    return res.status(200).json({
      message: "Page image updated successfully",
      selected_index: safeIndex,
      pdf_url: finalBookState?.pdf_url || null,
      pdf_ready: Boolean(finalBookState?.pdf_url),
      final_pdf_status: finalBookState?.final_pdf_status || "not_ready",
      auto_generate_pdf_at: finalBookState?.auto_generate_pdf_at || null,
      ok: true,
    });
  } catch (error) {
    console.log("Error updating page image:", error);
    return res.status(500).json({
      error: "Failed to update page image",
      ok: false,
    });
  }
};

export const generateFinalPdf = async (req, res) => {
  try {
    const { req_id, book_id } = req.body;

    if (!req_id) {
      return res.status(400).json({
        ok: false,
        error: "req_id is required",
      });
    }

    await maybeGenerateFinalPdfIfDue(req_id);

    const currentParent = await ParentModel.findOne({ req_id });
    if (currentParent?.pdf_url) {
      return res.status(200).json({
        ok: true,
        message: "Final PDF is already ready",
        ...getFinalPdfState(currentParent),
      });
    }

    const result = await generateFinalPdfForSelections({
      req_id,
      book_id,
      childName: currentParent?.kidName || null,
      trigger: "manual",
    });

    if (!result) {
      return res.status(409).json({
        ok: false,
        message: "Book is not ready for final PDF generation yet.",
      });
    }

    if (result.pdf_url) {
      return res.status(200).json({
        ok: true,
        message: "Final PDF generated successfully",
        ...result,
      });
    }

    const statusCode = result.final_pdf_status === "failed" ? 500 : 409;

    return res.status(statusCode).json({
      ok: false,
      message:
        result.final_pdf_status === "failed"
          ? "Final PDF generation failed. Please try again."
          : "Book is not ready for final PDF generation yet.",
      ...result,
    });
  } catch (error) {
    console.error("Error generating final PDF:", error);
    return res.status(500).json({
      ok: false,
      error: "Failed to generate final PDF",
    });
  }
};

export const createParentAndSendMail = async (req, res) => {
  try {
    const {
      name,
      email,
      kidName,
      req_id,
      book_id,
      notify = false,
    } = req.body;

    const normalizedNotify = Boolean(notify);

    const parentDetail = await ParentModel.findOneAndUpdate(
      { req_id },
      {
        $set: {
          name,
          email,
          kidName,
          notify: normalizedNotify,
        },
        $setOnInsert: {
          req_id,
        },
      },
      { upsert: true, new: true },
    );

    let previewEmailSent = Boolean(parentDetail.preview_email_sent);

    if (normalizedNotify && !previewEmailSent) {
      try {
        await sendMail(req_id, name, kidName, book_id, email, true);

        await ParentModel.updateOne(
          { req_id },
          { $set: { preview_email_sent: true } },
        );

        previewEmailSent = true;
      } catch (error) {
        const message = getSendGridErrorMessage(error);
        console.error("Preview email failed:", message);

        return res.status(502).json({
          ok: false,
          preview_email_sent: false,
          message: "Parent saved, but preview email could not be sent.",
          error: message,
        });
      }
    }

    return res.status(200).json({
      ok: true,
      preview_email_sent: previewEmailSent,
      message: "Parent saved and email sent successfully",
    });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({
      message: "Failed to process request",
      error: error.message,
    });
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
  pdfUrl = null,
) => {
  if (!SENDGRID_API_KEY || !MAIL_SENDER) {
    console.warn("Email skipped because SendGrid is not fully configured.");
    return;
  }

  const previewQuery = new URLSearchParams({
    request_id: req_id,
    name: kidName,
    book_id,
    email: String(emailStatus),
  });
  const previewUrl = `${getFrontendBaseUrl()}/preview?${previewQuery.toString()}`;
  const parent = await ParentModel.findOne({ req_id });
  const effectivePdfUrl = pdfUrl || parent?.pdf_url || null;
  const effectivePdfReady = pdfReady || Boolean(effectivePdfUrl);

  const emailHtml = `
      <p>Dear ${name},</p>
      <p>${
        effectivePdfReady
          ? `${kidName}'s final storybook PDF is now ready!`
          : `We are crafting ${kidName}'s magical storybook!`
      }</p>

      ${
        effectivePdfReady
          ? `
            <p><strong>Download Full PDF:</strong></p>
            <a href="${effectivePdfUrl}" style="
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
    from: MAIL_SENDER,
    subject: effectivePdfReady
      ? `${kidName}'s StoryBook PDF is Ready!`
      : `${kidName}'s StoryBook Preview is Ready!`,
    html: emailHtml,
  };

  try {
    await sgMail.send(msg);
    console.log("Email sent");
  } catch (error) {
    console.error("SendGrid send failed:", getSendGridErrorMessage(error));
    throw error;
  }
};
