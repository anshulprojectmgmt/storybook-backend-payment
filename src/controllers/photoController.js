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

// Configure AWS S3
const s3 = new AWS.S3({
    accessKeyId: process.env.PROD_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.PROD_AWS_SECRET_ACCESS_KEY,
    region: process.env.PROD_AWS_REGION,
});

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
  console.log('add photo', req.body);
  const { file_url, file_name, request_id } = req.body;
  
    
        
        const photoDetails = {
            file_url,
            file_name,
            request_id,
        };

        // Save to database (pseudo code)
        const result = await KidPhotoModel.create(photoDetails);
        // await savePhotoToDatabase(photoDetails);

        res.status(200).json({ message: "Photo added successfully",photo_id: result._id , ok: true });
    } catch (error) {
        console.error("Error adding photo to DB:", error);
        res.status(500).json({ error: "Failed to add photo" , ok: false });
    }
};


export const getGeneratedImage = async (req,res) => {

  const  {req_id, page_number, book_id} = req.query;
  
  try {
    
// memoization
// before generating new image check we have image alredy ready for 
// this unique combination --> (req_id & book_id & page_number)
// if yes return job_id

const storedKidDetail = await AiKidImageModel.findOne({req_id, page_number: parseInt(page_number)});

if(storedKidDetail) { 
  return res.status(200).json({
    job_id: storedKidDetail.job_id,
    ok: true,
  });
}




     
// get original images from DB based on request_id
  const originalImages = await KidPhotoModel.find({ request_id: req_id },{file_url:1});
  if (!originalImages || originalImages.length === 0) { 
    return res.status(404).json({ error: "No images found for this request ID", ok: false });
  }

// get scene details from DB based on book_id & page_number
  const sceneDetails = await SceneModel.findOne({ book_id: book_id, page_number: parseInt(page_number) });
    
  
const bodyData = {
    original_image_urls_s3: originalImages.map(image => image.file_url),
    scene: sceneDetails.scene,
    base_image_url: sceneDetails.sceneUrl || "",
    prompt: sceneDetails.prompt,
    req_id,
    page_number: parseInt(page_number),
    book_id,
    };

// console.log('body data for ai image generation:', bodyData);

// get AI image for the provided scene and original images

const aiImageDetails = await axios.post('https://i1u9iiq9h1.execute-api.ap-south-1.amazonaws.com/dev/generate',bodyData);
        
       res.status(200).json({...aiImageDetails.data, ok: true,});



  } catch (error) {

    console.error("Error generating image:", error);
    res.status(500).json({ error: "Failed to generate image", ok: false });
  }
}




export const checkGenerationStatus = async (req, res) => {
      try {
        const { page_number, book_id, job_id } = req.query;

        const aiImageDetail = await AiKidImageModel.findOne({job_id});
        
        if(aiImageDetail.status === "completed") {
          const sceneDetails = await SceneModel.findOne({ book_id: book_id, page_number});
          const book = await StoryBookModel.findOne({ _id: book_id }, { page_count: 1 });
          const next=  page_number < book.page_count ? true : false;
          res.status(200).json({...aiImageDetail.toObject() ,scene: sceneDetails.scene, next, ok: true});

      // if it is a last page then invoke notify webhook
          const parentDetails = await ParentModel.findOne({ req_id: aiImageDetail.req_id });
          if(next === false && parentDetails && parentDetails.notify) {
            // send email to parent
            await sendMail(aiImageDetail.req_id, parentDetails.name, parentDetails.kidName, book_id, parentDetails.email);
            console.log("Email notification send to parent mail:", parentDetails.email);
          }
          
        } else {
          res.status(200).json({status: aiImageDetail.status, image_urls: aiImageDetail.image_urls, ok: true});
        }
      } catch (error) {
        console.log("Error checking generation status:", error);
        res.status(500).json({ error: "Failed to check generation status", ok: false });
      }
      };


export const updatePageImage = async (req, res) => {
  try {
      const {req_id,job_id, image_id} = req.body;
      
      await AiKidImageModel.updateOne({req_id, job_id}, {
        $set: {
          image_idx: image_id,
        }
      })
      res.status(200).json({ message: "Page image updated successfully", ok: true });
  } catch (error) {
    console.log("Error updating page image:", error);
    res.status(500).json({ error: "Failed to update page image", ok: false });
    }
}



export const createParentAndSendMail = async (req, res) => {
  try {
    const { name, email, kidName, req_id, book_id ,notify=false} = req.body;
    console.log('notify 1:', notify);
// 1. Save parent info to DB
   const parentDeatil =  await ParentModel.findOneAndUpdate(
    { req_id }, // filter
    { $setOnInsert: { name, email, kidName, req_id ,notify} }, // only insert if not found
    { upsert: true, new: true } // new: true returns the document
  );



    if(!notify) {
      await sendMail(req_id, name, kidName, book_id, email, true);
    }

    res.status(200).json({ message: 'Parent saved and email sent successfully' });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Failed to process request', error: error.message });
  }
};


const sendMail = async (req_id,name,kidName,book_id,email,emailStatus=false) => {
  try {

          // 2. Generate preview URL
    const previewUrl = `https://storybook-mu-inky.vercel.app/preview?request_id=${req_id}&name=${kidName}&book_id=${book_id}&email=${emailStatus}`;

    // 3. Create nodemailer transporter
    const transporter = nodemailer.createTransport({
      service: 'gmail',
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
      <p>Warmest regards,<br>The Imagitime Team</p>
    `;

    // 5. Send email
    await transporter.sendMail({
      from: `"Storybook" <${process.env.MAIL_USER}>`,
      to: email,
      subject: `Preview and Refine ${kidName}'s Magical Book!`,
      html: emailHtml,
    });

  } catch (error) {
    consoel.error('Error sending email:', error);
  }
}



  