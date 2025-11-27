import AWS from "aws-sdk";
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import Jimp from "jimp";
import sharp from "sharp";
import { createCanvas, loadImage } from "@napi-rs/canvas";

import KidPhotoModel from "../models/kidPhotoModel.js";
import SceneModel from "../models/sceneModel.js";
import StoryBookModel from "../models/StoryBookModel.js";
import AiKidImageModel from "../models/aiKidImageModel.js";
import ParentModel from "../models/parentModel.js";
import nodemailer from "nodemailer";
import axios from "axios";
import FormData from "form-data";
import sgMail from "@sendgrid/mail";
// import { createBackCover } from "../helper/createBackCover.js";
// import { createFrontCoverWithLogo } from "../helper/createFrontCoverWithLogo.js";
import { createFrontCoverCanvas } from "../helper/createFrontCoverCanvas.js";
import { addFixedPrintMargin } from "../helper/addFixedPrintMargin.js";

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Configure AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.PROD_AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.PROD_AWS_SECRET_ACCESS_KEY,
  region: process.env.PROD_AWS_REGION,
});
const REMAKER_API_KEY = process.env.REMAKER_API_KEY;
const CREATE_JOB_URL =
  "https://developer.remaker.ai/api/remaker/v1/face-swap/create-job";

/** Utility: fetch S3 object as Buffer */

export async function fetchS3Buffer(s3Url) {
  try {
    const url = new URL(s3Url);

    // Case 1: Standard S3 URL (bucket-name.s3.amazonaws.com/key)
    if (url.hostname.includes(".s3.amazonaws.com")) {
      const bucket = url.hostname.split(".s3.amazonaws.com")[0];
      const key = decodeURIComponent(url.pathname.slice(1));

      const data = await s3.getObject({ Bucket: bucket, Key: key }).promise();
      return data.Body;
    }

    // Case 2: Pre-signed URL (s3.amazonaws.com/bucket/key?...signature)
    if (url.hostname === "s3.amazonaws.com") {
      const pathParts = url.pathname.split("/").filter(Boolean);
      const bucket = pathParts.shift();
      const key = decodeURIComponent(pathParts.join("/"));

      const data = await s3.getObject({ Bucket: bucket, Key: key }).promise();
      return data.Body;
    }

    // Case 3: Non-S3 or CDN URL — fallback to normal HTTP fetch
    const response = await axios.get(s3Url, { responseType: "arraybuffer" });
    return Buffer.from(response.data);
  } catch (err) {
    console.error("Error fetching from S3:", err.message, "URL:", s3Url);
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
    // memoization
    // before generating new image check we have image alredy ready for
    // this unique combination --> (req_id & book_id & page_number)
    // if yes return job_id

    const storedKidDetail = await AiKidImageModel.findOne({
      req_id,
      page_number: parseInt(page_number),
    });

    if (storedKidDetail) {
      return res.status(200).json({
        job_id: storedKidDetail.job_id,
        ok: true,
      });
    }

    // get original images from DB based on request_id
    const originalImages = await KidPhotoModel.find(
      { request_id: req_id },
      { file_url: 1 }
    );
    if (!originalImages || originalImages.length === 0) {
      return res
        .status(404)
        .json({ error: "No images found for this request ID", ok: false });
    }

    // get scene details from DB based on book_id & page_number
    const sceneDetails = await SceneModel.findOne({
      book_id: book_id,
      page_number: parseInt(page_number),
    });

    // const bodyData = {
    //   original_image_urls_s3: originalImages.map((image) => image.file_url),
    //   scene: sceneDetails.scene,
    //   base_image_url: sceneDetails.sceneUrl || "",
    //   prompt: sceneDetails.prompt,
    //   req_id,
    //   page_number: parseInt(page_number),
    //   book_id,
    // };

    // *********** pranitha python lambda call start ********************
    // console.log('body data for ai image generation:', bodyData);

    // get AI image for the provided scene and original images
    // const aiImageDetails = await axios.post('https://kdjpysy867.execute-api.ap-south-1.amazonaws.com/generate',bodyData);
    //   res.status(200).json({...aiImageDetails.data, ok: true});

    //  **************************************************************************
    // *********** pranitha python lambda call END ********************

    // Using Remaker API to generate image
    // https://remaker.ai/docs/api-reference/create-job
    // ****************************************************************************

    // implement remaker api call here
    // Using Remaker API to generate image
    const target_url = sceneDetails.sceneUrl || "";
    const swap_url = originalImages[0].file_url || "";
    if (!target_url || !swap_url) {
      return res.status(400).json({ error: "Missing image URLs" });
    }

    console.log("target_url-----", target_url);
    console.log("swap_url-------", swap_url);

    // 1. Get and compress images
    const targetBuffer = await fetchS3Buffer(target_url);
    const swapBuffer = await fetchS3Buffer(swap_url);

    const compressedTarget = await sharp(targetBuffer)
      .jpeg({ quality: 85 })
      .toBuffer();
    const compressedSwap = await sharp(swapBuffer)
      .jpeg({ quality: 85 })
      .toBuffer();

    // 2. Build form data
    const form = new FormData();
    form.append("target_image", compressedTarget, { filename: "target.jpg" });
    form.append("swap_image", compressedSwap, { filename: "swap.jpg" });

    // 3. Upload to Remaker with high timeout
    const response = await axios.post(CREATE_JOB_URL, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: REMAKER_API_KEY,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 180000, // <-- increased timeout
    });

    const data = response.data;
    if (data.code !== 100000) {
      return res.status(500).json({
        error: "Remaker job creation failed",
        detail: data,
      });
    }

    // create a record for aikidImageModel before returning
    // await AiKidImageModel.insertOne({
    //   req_id,
    //   job_id: data.result.job_id,
    //   book_id,
    //   page_number: parseInt(page_number),
    //   status: "pending",
    //   image_urls: null,
    //   image_idx: 0,
    //   created_at: new Date(),
    //   updated_at: new Date(),
    // });
    await AiKidImageModel.insertOne({
      req_id,
      job_id: data.result.job_id,
      book_id,
      page_number: parseInt(page_number),
      status: "pending",
      image_urls: null,
      image_idx: 0,
      front_cover_url: null,
      back_cover_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    console.log("created the aikidImage Model");
    // invoke poll remaker and don't wait for it
    // Use a non-overlapping setTimeout-chain with exponential backoff to avoid
    // concurrent polls and to allow controlled retries/backoff.
    const jobId = data.result.job_id;

    (function pollWithBackoff(attempt = 0) {
      const delay = 15000; // fixed 15s interval

      setTimeout(async () => {
        // CORRECTED LOGIC STARTS HERE
        try {
          const result = await pollFaceSwap(jobId);
          if (result && result.code === 100000) {
            // 1. Download the initial image from Remaker
            const response = await fetch(result.result.output_image_url[0]);
            const arrayBuffer = await response.arrayBuffer();
            const initialBuffer = Buffer.from(arrayBuffer); // Use a clear variable name

            // 2. Add the caption
            const sceneDetails = await SceneModel.findOne({
              book_id,
              page_number,
            });
            let captionText =
              sceneDetails?.scene || "Your AI story caption here";
            // replacing the {kid} with actual child name
            captionText = captionText.replaceAll("{kid}", childName);
            const captionedBuffer = await addCaptionWithCanva(
              initialBuffer,
              captionText
            );

            // 3. Upload the captioned image (Image 1)
            console.log("Uploading captioned image to S3...");
            const captionFileName = `ai_result_${jobId}_caption.jpg`;
            const captionS3Key = `ai_generated_images/${captionFileName}`;

            // Save to a temporary local file for uploading
            const captionLocalPath = path.join("/tmp", captionFileName);
            fs.writeFileSync(captionLocalPath, captionedBuffer);

            const uploadResultCaption = await uploadLocalFileToS3(
              captionLocalPath,
              captionS3Key,
              "image/jpeg"
            );
            const s3UrlCaption = uploadResultCaption.Location; // Renamed to avoid confusion
            console.log("Uploaded captioned image:", s3UrlCaption);

            // 4. Create the margin image from the captioned buffer
            const marginSide = page_number % 2 !== 0 ? "left" : "right";
            console.log(
              `Page ${page_number} is ${
                marginSide === "left" ? "ODD" : "EVEN"
              }. Adding margin to the ${marginSide}.`
            );

            const marginBuffer = await addFixedPrintMargin(
              captionedBuffer,
              page_number
            );

            // 5. Upload the margin image (Image 2)
            console.log("Uploading image with margin to S3...");
            const marginFileName = `ai_result_${jobId}_margin.jpg`;
            const marginS3Key = `ai_generated_images/${marginFileName}`;

            // Save to another temporary local file
            const marginLocalPath = path.join("/tmp", marginFileName);
            fs.writeFileSync(marginLocalPath, marginBuffer);

            const uploadResultMargin = await uploadLocalFileToS3(
              marginLocalPath,
              marginS3Key,
              "image/jpeg"
            );
            const s3UrlWithMargin = uploadResultMargin.Location;
            console.log("Uploaded image with margin:", s3UrlWithMargin);

            // 6. Update the database with BOTH URLs
            // console.log("Updating database with both URLs...");
            await AiKidImageModel.updateOne(
              { job_id: jobId },
              {
                $set: {
                  status: "completed",
                  image_urls: [s3UrlCaption, s3UrlWithMargin], // Use both variables
                  // image_urls: s3UrlWithMargin, // Use both variables
                  updated_at: new Date(),
                },
              }
            );
            // // ---  Generate Special Covers ---
            // const logoUrl = process.env.COMPANY_LOGO_URL;
            const book = await StoryBookModel.findOne(
              { _id: book_id },
              { page_count: 1, title: 1 }
            );

            // // Back Cover (Page 2)
            // ✅ Fixed Back Cover (from env, same for all books)
            // const fixedBackCoverUrl = process.env.DEFAULT_BACK_COVER_URL;
            // if (fixedBackCoverUrl) {
            //   await AiKidImageModel.updateOne(
            //     { req_id },
            //     { $set: { back_cover_url: fixedBackCoverUrl } }
            //   );
            //   console.log("✅ Assigned fixed back cover:", fixedBackCoverUrl);
            // }
            const fixedBackCoverUrl = process.env.DEFAULT_BACK_COVER_URL;
            if (fixedBackCoverUrl) {
              await AiKidImageModel.updateOne(
                { req_id },
                { $set: { back_cover_url: fixedBackCoverUrl } }
              );
              console.log("✅ Assigned fixed back cover:", fixedBackCoverUrl);
            }
            //  Front Cover (Last Page) - Canvas front cover
            if (parseInt(page_number) === book.page_count) {
              console.log("Generating front cover (CANVAS)...");

              // Save original (non-captioned, non-margin) page to temp file
              const finalPageFileName = `last_page_${jobId}.jpg`;
              const finalPageLocalPath = `/tmp/${finalPageFileName}`;
              fs.writeFileSync(finalPageLocalPath, initialBuffer);

              // Upload last page to S3
              const finalPageUpload = await uploadLocalFileToS3(
                finalPageLocalPath,
                `storybook_pages/${finalPageFileName}`,
                "image/jpeg"
              );

              const lastPageUrl = finalPageUpload.Location;
              console.log("✅ Last page uploaded to S3:", lastPageUrl);

              // Generate front cover using Canvas (NEW HELPER)
              const frontCoverS3Url = await createFrontCoverCanvas(
                lastPageUrl,
                childName,
                process.env.COMPANY_LOGO_URL, // send logo URL
                book.title
              );

              // Save final front cover URL to DB
              await AiKidImageModel.updateOne(
                { req_id },
                { $set: { front_cover_url: frontCoverS3Url } }
              );

              console.log("🎉 Final Front Cover Ready:", frontCoverS3Url);

              // Cleanup
              try {
                fs.unlinkSync(finalPageLocalPath);
              } catch (e) {
                console.warn(
                  "Could not delete last page temp file:",
                  e.message
                );
              }
            }

            // if (parseInt(page_number) === book.page_count) {
            //   console.log("Generating front cover (PLACID)...");

            //   // ✅ Use REMAKER ORIGINAL IMAGE (initialBuffer) NOT caption or margin image
            //   const finalPageFileName = `last_page_${jobId}.jpg`;
            //   const finalPageLocalPath = `/tmp/${finalPageFileName}`;
            //   fs.writeFileSync(finalPageLocalPath, initialBuffer);

            //   // ✅ Upload initialBuffer to S3
            //   const finalPageUpload = await uploadLocalFileToS3(
            //     finalPageLocalPath,
            //     `storybook_pages/${finalPageFileName}`,
            //     "image/jpeg"
            //   );
            //   const lastPageUrl = finalPageUpload.Location;
            //   console.log("✅ Last page uploaded to S3:", lastPageUrl);

            //   // ✅ Generate cover via Placid → then upload to S3 → return final S3 URL
            //   const frontCoverS3Url = await createFrontCoverWithCanvas(
            //     lastPageUrl,
            //     childName
            //   );

            //   // ✅ Save final front cover to DB
            //   await AiKidImageModel.updateOne(
            //     { req_id },
            //     { $set: { front_cover_url: frontCoverS3Url } }
            //   );

            //   fs.unlinkSync(finalPageLocalPath);
            //   console.log("🎉 Final Front Cover Ready:", frontCoverS3Url);
            // }

            // 7. Cleanup local files
            // try {
            fs.unlinkSync(captionLocalPath);
            //   fs.unlinkSync(marginLocalPath);
            // } catch (e) {
            //   console.warn("Could not clean up temporary files:", e);
            // }

            return; // finished, stop polling
          }

          // not completed yet -> schedule next poll
          pollWithBackoff(attempt + 1);
        } catch (pollErr) {
          console.error(
            "An error occurred during image processing or upload:",
            pollErr
          );
          // On any error, schedule a retry with backoff
          pollWithBackoff(attempt + 1);
        }
      }, delay);
    })();
    return res.status(200).json({ job_id: data.result.job_id, ok: true });
  } catch (error) {
    console.error("Error generating image:", error);
    res.status(500).json({ error: "Failed to generate image", ok: false });
  }
};

/** upload a local file to S3 (same approach as storeOriginalImageToS3) */
export async function uploadLocalFileToS3(
  localFilePath,
  s3Key,
  contentType = "image/jpeg"
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
    }
  );
  const data = await resp.json();

  return data;
}

export const checkGenerationStatus = async (req, res) => {
  try {
    const { page_number, book_id, job_id } = req.query;

    const aiImageDetail = await AiKidImageModel.findOne({ job_id });

    if (aiImageDetail.status === "completed") {
      const sceneDetails = await SceneModel.findOne({
        book_id: book_id,
        page_number,
      });
      const book = await StoryBookModel.findOne(
        { _id: book_id },
        { page_count: 1 }
      );
      const next = page_number < book.page_count ? true : false;

      res.status(200).json({
        ...aiImageDetail.toObject(),
        scene: sceneDetails.scene,
        next,
        pdf_url: parentDetails?.pdf_url || null,
        ok: true,
      });

      // if it is a last page then invoke notify webhook
      const parentDetails = await ParentModel.findOne({
        req_id: aiImageDetail.req_id,
      });
      if (next === false && parentDetails && parentDetails.notify) {
        // send email to parent
        await sendMail(
          aiImageDetail.req_id,
          parentDetails.name,
          parentDetails.kidName,
          book_id,
          parentDetails.email
        );
        console.log(
          "Email notification send to parent mail:",
          parentDetails.email
        );
      }
    } else {
      res.status(200).json({
        status: aiImageDetail.status,
        image_urls: aiImageDetail.image_urls,
        ok: true,
      });
    }
  } catch (error) {
    console.log("Error checking generation status:", error);
    res
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
      }
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
      { upsert: true, new: true } // new: true returns the document
    );

    // if (!notify) {
    //   await sendMail(req_id, name, kidName, book_id, email, true);
    // }
    if (!notify) {
      try {
        await sendMail(req_id, name, kidName, book_id, email, true);
      } catch (err) {
        return res
          .status(500)
          .json({ message: "Email failed", error: err.message });
      }
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

const sendMail = async (
  req_id,
  name,
  kidName,
  book_id,
  email,
  emailStatus = false
) => {
  const previewUrl = `http://localhost:5173/preview?request_id=${req_id}&name=${kidName}&book_id=${book_id}&email=${emailStatus}`;

  const msg = {
    to: email,
    from: process.env.MAIL_SENDER, // Verified sender in SendGrid
    subject: `Preview and Refine ${kidName}'s Magical Book!`,
    html: `
      <p>Dear ${name},</p>
      <p>Congratulations on crafting ${kidName}'s magical book!</p>
      <p><strong>${kidName}'s Book Preview:</strong></p>
      <p>Click below to view and refine the book:</p>
      <a href="${previewUrl}" style="
        display:inline-block;padding:12px 20px;
        background-color:#007BFF;color:white;
        text-decoration:none;font-weight:bold;border-radius:4px;
        margin:20px 0;">Refine ${kidName}'s Book</a>
      <p>If you have questions, just reply to this email.</p>
      <p>Warm regards,<br/>StoryBook Team</p>
    `,
  };

  await sgMail.send(msg);
  console.log("Preview email sent to:", email);
};
