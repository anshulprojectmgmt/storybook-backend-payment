import AWS from "aws-sdk";
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";

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
            return res.status(400).json({ error: "No file uploaded" , ok: false});
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
    console.log("File uploaded successfully:");
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

export const getGeneratedImage = async (req, res) => {
  const { req_id, page_number, book_id } = req.query;

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

    const bodyData = {
      original_image_urls_s3: originalImages.map((image) => image.file_url),
      scene: sceneDetails.scene,
      base_image_url: sceneDetails.sceneUrl || "",
      prompt: sceneDetails.prompt,
      req_id,
      page_number: parseInt(page_number),
      book_id,
    };
  
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

    // invoke poll remaker and don't wait for it
    // Use a non-overlapping setTimeout-chain with exponential backoff to avoid
    // concurrent polls and to allow controlled retries/backoff.
    const jobId = data.result.job_id;

    (function pollWithBackoff(attempt = 0) {
      // const baseDelayMs = 10000; // 10s
      // const maxDelayMs = 5 * 60 * 1000; // 5 minutes
      // const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const delay = 15000; // fixed 15s interval
      

      setTimeout(async () => {
        try {
          const result = await pollFaceSwap(jobId);
          if (result && result.code === 100000) {
            // first we have to store image gets from output_image_url into s3 abd pass s3 url to db
            // Download the image locally first
            const response = await fetch(result.result.output_image_url[0]);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const localFileName = `ai_result_${jobId}.jpg`;
            const localFilePath = path.join("/tmp", localFileName);
            fs.writeFileSync(localFilePath, buffer);

            // Upload to S3 using the same approach as storeOriginalImageToS3
            const s3Key = `ai_generated_images/${localFileName}`;
            let uploadResult;
            try {
              uploadResult = await uploadLocalFileToS3(localFilePath, s3Key, "image/jpeg");
            } catch (uploadErr) {
              console.error("Failed uploading generated image to S3:", uploadErr);
              // cleanup local file then schedule retry
              try { fs.unlinkSync(localFilePath); } catch(e){ /* ignore */ }
              return pollWithBackoff(attempt + 1);
            }

            const s3Url = uploadResult.Location;
           
           
            // Update DB record with final status and image urls
            try {
              await AiKidImageModel.updateOne(
                { job_id: jobId },
                {
                  $set: {
                    status: "completed",
                    image_urls: [s3Url] || null,
                    updated_at: new Date(),
                  },
                }
              );
            } catch (dbErr) {
              console.error(
                "Failed to update AiKidImageModel after completion:",
                dbErr
              );
            }
            return; // finished, stop polling
          }

          // not completed yet -> schedule next poll with increased attempt
          pollWithBackoff(attempt + 1);
        } catch (pollErr) {
          console.error("Error while polling Remaker job:", pollErr);
          // On polling error, schedule a retry with backoff
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
async function uploadLocalFileToS3(localFilePath, s3Key, contentType = "image/jpeg") {
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
    console.log("notify 1:", notify);
    // 1. Save parent info to DB
    const parentDeatil = await ParentModel.findOneAndUpdate(
      { req_id }, // filter
      { $setOnInsert: { name, email, kidName, req_id, notify } }, // only insert if not found
      { upsert: true, new: true } // new: true returns the document
    );

    if (!notify) {
      await sendMail(req_id, name, kidName, book_id, email, true);
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
    const previewUrl = `https://storybook-mu-inky.vercel.app/preview?request_id=${req_id}&name=${kidName}&book_id=${book_id}&email=${emailStatus}`;

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
  }
};
