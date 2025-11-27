import sharp from "sharp";

export async function addFixedPrintMargin(imageBuffer, pageNumber) {
  const DPI = 300;
  const A4_WIDTH_PX = Math.round((297 / 25.4) * DPI); // 3508 px
  const A4_HEIGHT_PX = Math.round((210 / 25.4) * DPI); // 2480 px
  const MARGIN_MM = 15;
  const MARGIN_PX = Math.round((MARGIN_MM / 25.4) * DPI); // 177 px

  // Your input image should already be 3331x2480 px
  // (A4 minus 15mm margin)

  const isOdd = pageNumber % 2 !== 0;
  const leftMargin = isOdd ? MARGIN_PX : 0;
  //   const rightMargin = isOdd ? 0 : MARGIN_PX;

  // Create a white A4 canvas
  const final = await sharp({
    create: {
      width: A4_WIDTH_PX,
      height: A4_HEIGHT_PX,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      {
        input: imageBuffer,
        top: 0,
        left: leftMargin, // shift image based on page parity
      },
    ])
    .jpeg({ quality: 95 })
    .toBuffer();

  return final;
}
