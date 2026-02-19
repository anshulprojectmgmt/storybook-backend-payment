import ParentModel from "../models/parentModel.js";

export const saveAddress = async (req, res) => {
  try {
    const { req_id, name, email, phone, address, kidName } = req.body;

    if (
      !address?.line1 ||
      !address?.city ||
      !address?.state ||
      !address?.pincode ||
      !address?.country
    ) {
      return res.status(400).json({
        ok: false,
        message: "Incomplete address",
      });
    }

    await ParentModel.findOneAndUpdate(
      { req_id },
      {
        $set: {
          name,
          email,
          phone,
          kidName,
          address,
        },
      },
      { upsert: true },
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Save address error:", err);
    res.status(500).json({ ok: false });
  }
};
