import AiKidImageModel from "../models/aiKidImageModel.js";
import ParentModel from "../models/parentModel.js";
import StoryBookModel from "../models/StoryBookModel.js";
import { maybeGenerateFinalPdfIfDue } from "./photoController.js";

function getFinalPdfStatus(parent) {
  if (parent?.pdf_url) {
    return "ready";
  }

  return parent?.final_pdf_status || "not_ready";
}

function getImageOptions(doc) {
  if (Array.isArray(doc.image_options) && doc.image_options.length > 0) {
    return doc.image_options.map((option, index) => ({
      option_idx:
        typeof option.option_idx === "number" ? option.option_idx : index,
      preview_url: option.preview_url || option.print_url || null,
      raw_url: option.raw_url || option.preview_url || option.print_url || null,
      print_url: option.print_url || option.preview_url || null,
      source_image_url: option.source_image_url || null,
      job_id: option.job_id || null,
    }));
  }

  if (Array.isArray(doc.image_urls) && doc.image_urls.length > 0) {
    return [
      {
        option_idx: 0,
        preview_url: doc.image_urls[0] || null,
        raw_url: doc.image_urls[0] || doc.image_urls[1] || null,
        print_url: doc.image_urls[1] || doc.image_urls[0] || null,
        source_image_url: null,
        job_id: doc.job_id || null,
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
    typeof doc.image_idx === "number" &&
    doc.image_idx >= 0 &&
    doc.image_idx < options.length
      ? doc.image_idx
      : 0;

  return options[safeIndex] || options[0];
}

export const getAllBookPages = async (req, res) => {
  try {
    const { req_id, book_id: requestedBookId } = req.query;

    await maybeGenerateFinalPdfIfDue(req_id);

    const [docs, parent] = await Promise.all([
      AiKidImageModel.find(
        { req_id, status: "completed" },
        {
          page_number: 1,
          image_urls: 1,
          image_options: 1,
          image_idx: 1,
          front_cover_url: 1,
          back_cover_url: 1,
          status: 1,
          job_id: 1,
          req_id: 1,
          book_id: 1,
        },
      ).sort({ page_number: 1 }),
      ParentModel.findOne(
        { req_id },
        {
          pdf_url: 1,
          preview_email_sent: 1,
          payment: 1,
          kidName: 1,
          final_pdf_status: 1,
          auto_generate_pdf_at: 1,
          final_book_ready_at: 1,
        },
      ),
    ]);

    const effectiveBookId = docs[0]?.book_id || requestedBookId || null;
    const book = effectiveBookId
      ? await StoryBookModel.findById(effectiveBookId, { page_count: 1 }).lean()
      : null;

    if (!docs.length) {
      return res.status(200).json({
        pages: [],
        page_details: [],
        front_cover_url: null,
        back_cover_url: null,
        page_count: Number(book?.page_count || 0),
        kid_name: parent?.kidName || null,
        pdf_url: parent?.pdf_url || null,
        pdf_ready: Boolean(parent?.pdf_url),
        final_pdf_status: getFinalPdfStatus(parent),
        auto_generate_pdf_at: parent?.auto_generate_pdf_at || null,
        final_book_ready_at: parent?.final_book_ready_at || null,
        preview_email_sent: Boolean(parent?.preview_email_sent),
        paid: parent?.payment === "paid",
        ok: true,
      });
    }

    const pageDetails = docs.map((doc) => {
      const options = getImageOptions(doc);
      const selectedOption = getSelectedOption(doc);

      return {
        req_id: doc.req_id,
        book_id: doc.book_id,
        job_id: doc.job_id,
        page_number: doc.page_number,
        status: doc.status,
        image_idx:
          typeof doc.image_idx === "number" && doc.image_idx >= 0
            ? doc.image_idx
            : 0,
        image_urls: options.map(
          (option) => option.preview_url || option.print_url || null,
        ),
        image_options: options,
        selected_preview_url:
          selectedOption?.preview_url || selectedOption?.print_url || null,
        selected_print_url:
          selectedOption?.print_url || selectedOption?.preview_url || null,
      };
    });

    const pages = pageDetails
      .map((page) => page.selected_preview_url)
      .filter(Boolean);

    const front =
      docs.find((doc) => doc.front_cover_url)?.front_cover_url || null;
    const back = docs.find((doc) => doc.back_cover_url)?.back_cover_url || null;

    return res.status(200).json({
      front_cover_url: front,
      back_cover_url: back,
      pages,
      page_details: pageDetails,
      page_count: Number(book?.page_count || 0),
      kid_name: parent?.kidName || null,
      pdf_url: parent?.pdf_url || null,
      pdf_ready: Boolean(parent?.pdf_url),
      final_pdf_status: getFinalPdfStatus(parent),
      auto_generate_pdf_at: parent?.auto_generate_pdf_at || null,
      final_book_ready_at: parent?.final_book_ready_at || null,
      preview_email_sent: Boolean(parent?.preview_email_sent),
      paid: parent?.payment === "paid",
      ok: true,
    });
  } catch (err) {
    console.error("Error fetching pages:", err);
    return res.status(500).json({
      error: "Failed to fetch pages",
      ok: false,
    });
  }
};
