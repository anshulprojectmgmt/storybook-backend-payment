import StoryBookModel from "../models/StoryBookModel.js";

export const getAllStoryBooks = async (req, res) => {
  try {
    const storyBooks = await StoryBookModel.find({});
    res.status(200).json(storyBooks);
  } catch (error) {
    res.status(500).json({ message: "Error fetching story books" });
  }
};

export const createStoryBook = async (req, res) => {
  const {
    title,
    description,
    cover_photo,
    page_count,
    age_group,
    min_required_photos,
    source,
    author,
  } = req.body;
  //   console.log(req.body);
  try {
    const newStoryBook = new StoryBookModel({
      title,
      description,
      cover_photo,
      page_count,
      age_group,
      min_required_photos,
      source,
      author,
    });
    await newStoryBook.save();
    res
      .status(201)
      .json({ message: "Story book created successfully", ok: true });
  } catch (error) {
    console.error(error); // <-- ADD THIS
    res
      .status(500)
      .json({ message: "Error creating story book", ok: false, error });
  }
};

export const updateStoryBook = async (req, res) => {};

export const deleteStoryBook = async (req, res) => {};
