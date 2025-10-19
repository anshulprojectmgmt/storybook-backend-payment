import SceneModel from "../models/sceneModel.js";
import { uploadFileToS3 } from "../controllers/s3Upload.js";
import StoryBookModel from "../models/StoryBookModel.js";

export const createScene = async (req, res) => {
  const { book_id, page_number, scene, prompt, sceneUrl } = req.body;

  try {
    const newScene = new SceneModel({
      book_id,
      page_number,
      scene,
      prompt,
      sceneUrl,
    });
    await newScene.save();

    res
      .status(201)
      .json({ message: "Scene created successfully", ok: true, newScene });
  } catch (error) {
    console.error("Error creating scene:", error);
    res.status(500).json({ message: "Error creating scene", ok: false, error });
  }
};

/**
 * Controller to create multiple scenes in bulk.
 */
export const createBulkScenes = async (req, res) => {
  try {
    const { book_id } = req.body;
    const book = await StoryBookModel.findById(book_id);
    const book_name = book.title;
    // 1. Parse the stringified arrays from FormData
    const scenes = JSON.parse(req.body.scenes);
    const prompts = JSON.parse(req.body.prompts);

    // 2. Get the array of files from Multer
    const files = req.files;
    console.log(files, scenes, prompts, book_id, book_name);
    // 3. Validation check
    if (
      !files ||
      !scenes ||
      !book_id ||
      !book_name ||
      files.length !== scenes.length
    ) {
      return res.status(400).json({
        message:
          "Data mismatch. Make sure all fields are provided for every page.",
        ok: false,
      });
    }

    console.log(`Processing ${files.length} pages for book: ${book_name}`);
    // return res.status(200).json({ message: "ok" });
    // 4. Upload all files to S3 in parallel for maximum speed

    const uploadPromises = files.map((file) => uploadFileToS3(file, book_name));
    const s3Urls = await Promise.all(uploadPromises);

    // 5. Prepare all scene documents for the database
    const sceneDocuments = [];
    for (let i = 0; i < scenes.length; i++) {
      sceneDocuments.push({
        book_id: book_id,
        page_number: i + 1,
        scene: scenes[i],
        prompt: prompts[i], // This will be "" if the user left it blank
        sceneUrl: s3Urls[i],
      });
    }

    // 6. Insert all documents into MongoDB in a single operation
    let data = await SceneModel.insertMany(sceneDocuments);
    // console.log(data);
    res.status(201).json({
      message: `Successfully created ${sceneDocuments.length} scenes.`,
      ok: true,
      data,
    });
  } catch (error) {
    console.error("Error in bulk scene creation:", error);
    res.status(500).json({
      message: "Error creating scenes",
      ok: false,
      error: error.message,
    });
  }
};
