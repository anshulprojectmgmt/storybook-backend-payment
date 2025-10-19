import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({
  region: process.env.PROD_AWS_REGION,
  credentials: {
    accessKeyId: process.env.PROD_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.PROD_AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.PROD_AWS_S3_BUCKET_NAME;
const REGION = process.env.PROD_AWS_REGION;
/**
 * Uploads a file buffer to S3.
 * @param {Buffer} fileBuffer - The file buffer from multer.
 * @param {string} originalname - The original name of the file.
 * @param {string} mimetype - The mime type of the file.
 * @param {string} bookName - The name of the book, used as a folder.
 * @returns {Promise<string>} - The public URL of the uploaded file.
 */
export const uploadFileToS3 = async (file, bookName) => {
  console.log(REGION);

  // Sanitize book name to use as a folder
  const folderName = bookName.replace(/[^a-zA-Z0-9 ]/g, "_");
  //   const fileName = `${folderName}/${Date.now()}-${file.originalname}`;
  const fileName = `storybook_scenes/${folderName}/${Date.now()}-${
    file.originalname
  }`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: file.buffer,
    ContentType: file.mimetype,
  });

  try {
    await s3Client.send(command);
    // Construct the public URL
    const s3Url = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${fileName}`;
    return s3Url;
  } catch (error) {
    console.error("Error uploading to S3:", error);
    throw error;
  }
};
