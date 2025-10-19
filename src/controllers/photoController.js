import AWS from "aws-sdk";
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import Jimp from "jimp";

import KidPhotoModel from "../models/kidPhotoModel.js";
import SceneModel from "../models/sceneModel.js";
import StoryBookModel from "../models/StoryBookModel.js";
import AiKidImageModel from "../models/aiKidImageModel.js";
import ParentModel from "../models/parentModel.js";
import nodemailer from "nodemailer";
import axios from "axios";
import FormData from "form-data";

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
async function fetchS3Buffer(s3Url) {
  // parse bucket + key from S3 URL
  const url = new URL(s3Url);
  const bucket = url.hostname.split(".")[0]; // bucket-name.s3.amazonaws.com
  const key = decodeURIComponent(url.pathname.slice(1));

  const data = await s3.getObject({ Bucket: bucket, Key: key }).promise();
  return data.Body; // Buffer
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
async function addCaptionWithJimp(imageBuffer, captionText) {
  const img = await Jimp.read(imageBuffer);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);

  const maxCharsPerLine = 40;
  const lines = wrapText(captionText, maxCharsPerLine);

  const lineHeights = [];
  let textWidth = 0;
  let textHeight = 0;

  for (const line of lines) {
    const width = Jimp.measureText(font, line);
    const height = Jimp.measureTextHeight(font, line, 1000);
    lineHeights.push(height);
    textWidth = Math.max(textWidth, width);
    textHeight += height + 10; //12
  }

  // const paddingX = 25;
  const paddingY = 25;
  // ✅ Define your margin from the bottom here
  const marginBottom = 30; // Use a smaller number to move it down

  // const x = (img.bitmap.width - textWidth) / 2;
  const x = 0;
  const y = img.bitmap.height - textHeight - marginBottom; //100 ,90
  // ✅ Set the box's width to the full image width
  const boxWidth = img.bitmap.width;
  const boxHeight = textHeight + 2 * paddingY;

  // background box
  const box = new Jimp(
    // textWidth + 2 * paddingX, //2
    // textHeight + 2 * paddingY, //2
    boxWidth,
    boxHeight,
    Jimp.rgbaToInt(0, 0, 0, 160)
    // Jimp.rgbaToInt(75, 100, 255, 160)
  );
  // img.composite(box, x - paddingX, y - paddingY);
  img.composite(box, x, y - paddingY);

  // draw text lines
  let currentY = y;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineWidth = Jimp.measureText(font, line);
    const textX = (img.bitmap.width - lineWidth) / 2;
    img.print(font, textX, currentY, line);
    currentY += lineHeights[i] + 10; //15
  }

  return await img.getBufferAsync(Jimp.MIME_JPEG);
}

function wrapText(text, width) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + word).length > width) {
      lines.push(line.trim());
      line = "";
    }
    line += word + " ";
  }
  if (line) lines.push(line.trim());
  return lines;
}

async function addMarginWithJimp(imageBuffer, marginSize, marginColor, side) {
  const img = await Jimp.read(imageBuffer);
  const { width: originalWidth, height: originalHeight } = img.bitmap;

  let newWidth = originalWidth;
  let newHeight = originalHeight;
  let pasteX = 0;
  let pasteY = 0;

  // Calculate new dimensions and paste coordinates based on the side
  if (side === "left") {
    newWidth = originalWidth + marginSize;
    pasteX = marginSize;
  } else if (side === "right") {
    newWidth = originalWidth + marginSize;
  } else if (side === "top") {
    newHeight = originalHeight + marginSize;
    pasteY = marginSize;
  } else if (side === "bottom") {
    newHeight = originalHeight + marginSize;
  } else {
    throw new Error(
      "Invalid side specified. Use 'top', 'bottom', 'left', or 'right'."
    );
  }

  // Create a new blank canvas with the specified margin color
  const canvas = new Jimp(newWidth, newHeight, marginColor);

  // Paste the original image onto the new canvas at the correct offset
  canvas.composite(img, pasteX, pasteY);

  // Set JPEG quality to match the Python script's quality=95
  canvas.quality(95);

  // Return the final image as a buffer
  return await canvas.getBufferAsync(Jimp.MIME_JPEG);
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
    const target_url = sceneDetails.sceneUrl || "";
    const swap_url = originalImages[0].file_url || "";
    if (!target_url || !swap_url) {
      return res.status(400).json({ error: "Missing image URLs" });
    }

    // 1. Get binary data from S3
    const targetBuffer = await fetchS3Buffer(target_url);
    const swapBuffer = await fetchS3Buffer(swap_url);

    // 2. Build multipart form
    const form = new FormData();
    form.append("target_image", targetBuffer, { filename: "target.jpg" });
    form.append("swap_image", swapBuffer, { filename: "swap.jpg" });

    // 3. Call Remaker API
    const response = await axios.post(CREATE_JOB_URL, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: REMAKER_API_KEY,
      },
    });
    const data = response.data;

    if (data.code !== 100000) {
      return res
        .status(500)
        .json({ error: "Remaker job creation failed", detail: data });
    }

    // create a record for aikidImageModel before returning
    await AiKidImageModel.insertOne({
      req_id,
      job_id: data.result.job_id,
      book_id,
      page_number: parseInt(page_number),
      status: "pending",
      image_urls: null,
      image_idx: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });
    // console.log("created the aikidImage Model");
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
            const captionedBuffer = await addCaptionWithJimp(
              initialBuffer,
              captionText
            );

            // 3. Upload the captioned image (Image 1)
            // console.log("Uploading captioned image to S3...");
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
            // console.log("Uploaded captioned image:", s3UrlCaption);

            // 4. Create the margin image from the captioned buffer
            // console.log("Adding left margin to the image...");
            // Determine which side the margin should be on.
            const marginSide = page_number % 2 !== 0 ? "left" : "right";
            // console.log(
            //   `Page ${page_number} is ${
            //     marginSide === "left" ? "ODD" : "EVEN"
            //   }. Adding margin to the ${marginSide}.`
            // );
            const marginSize = 100;
            const marginColor = "#FFFFFF";
            const marginBuffer = await addMarginWithJimp(
              captionedBuffer,
              marginSize,
              marginColor,
              marginSide // Use the dynamic variable
            );

            // 5. Upload the margin image (Image 2)
            // console.log("Uploading image with margin to S3...");
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
            // console.log("Uploaded image with margin:", s3UrlWithMargin);

            // 6. Update the database with BOTH URLs
            // console.log("Updating database with both URLs...");
            await AiKidImageModel.updateOne(
              { job_id: jobId },
              {
                $set: {
                  status: "completed",
                  image_urls: [s3UrlCaption, s3UrlWithMargin], // Use both variables
                  updated_at: new Date(),
                },
              }
            );

            // 7. Cleanup local files
            try {
              fs.unlinkSync(captionLocalPath);
              fs.unlinkSync(marginLocalPath);
            } catch (e) {
              console.warn("Could not clean up temporary files:", e);
            }

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
async function uploadLocalFileToS3(
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

const sendMail = async (
  req_id,
  name,
  kidName,
  book_id,
  email,
  emailStatus = false
) => {
  try {
    // 2. Generate preview URL
    const previewUrl = `https://storybookg.netlify.app/preview?request_id=${req_id}&name=${kidName}&book_id=${book_id}&email=${emailStatus}`;
    // 3. Create nodemailer transporter
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      },
    });

    // 4. Compose HTML email
    const emailHtml = `
      <p>Dear ${name},</p>
      <p>
        Congratulations on taking the first step in crafting ${kidName}'s magical book with Storybook! 
        Unlike any other personalized books, they're not just a name on a page; 
        they're the star, brought to life through personalized illustrations. 🌈📖
      </p>
      <p><strong>${kidName}'s Book Preview:</strong></p>
      <p>Your magical creation is underway! Feel free to refine it and show it to others by clicking the button below.</p>
      <a href="${previewUrl}" style="
        display: inline-block;
        padding: 12px 20px;
        background-color: #007BFF;
        color: white;
        text-decoration: none;
        font-weight: bold;
        border-radius: 4px;
        margin: 20px 0;
      ">Refine ${kidName}'s Book</a>
      <p><strong>Questions?</strong></p>
      <p>If you have any questions or need further assistance, simply reply to this email. 
      We're here to help you craft a treasured keepsake for ${kidName}.</p>
      <p>Warmest regards,<br>The StoryBook Team</p>
    `;

    // 5. Send email
    await transporter.sendMail({
      from: `"Storybook" <${process.env.MAIL_USER}>`,
      to: email,
      subject: `Preview and Refine ${kidName}'s Magical Book!`,
      html: emailHtml,
    });
  } catch (error) {
    console.error("Error sending email:", error);
    throw error;
  }
};
