import AiKidImageModel from "../models/aiKidImageModel.js";

export const getAllBookPages = async (req, res) => {
  try {
    const { req_id } = req.query;

    // Fetch all generated pages
    const aiImages = await AiKidImageModel.find(
      { req_id, status: "completed", image_urls: { $ne: null } },
      { page_number: 1, image_urls: 1 }
    ).sort({ page_number: 1 });

    // Get covers (if exist)
    const coverData = await AiKidImageModel.findOne(
      { req_id },
      { front_cover_url: 1, back_cover_url: 1 }
    );

    // Wait for covers to exist (poll at most 15 sec)
    let retries = 0;
    while (
      (!coverData?.front_cover_url || !coverData?.back_cover_url) &&
      retries < 10
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      const refreshed = await AiKidImageModel.findOne(
        { req_id },
        { front_cover_url: 1, back_cover_url: 1 }
      );
      if (refreshed.front_cover_url && refreshed.back_cover_url) {
        coverData.front_cover_url = refreshed.front_cover_url;
        coverData.back_cover_url = refreshed.back_cover_url;
        break;
      }
      retries++;
    }

    res.status(200).json({
      front_cover_url: coverData?.front_cover_url || null,
      back_cover_url: coverData?.back_cover_url || null,
      pages: aiImages.map((p) => p.image_urls[0]),
    });
  } catch (err) {
    console.error("Error fetching pages:", err);
    res.status(500).json({ error: "Failed to fetch pages", ok: false });
  }
};
