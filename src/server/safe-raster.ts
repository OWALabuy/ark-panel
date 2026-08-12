import sharp, { type Metadata } from "sharp";

// Image bytes come from authenticated but untrusted browser uploads. Keep libvips'
// buffer loaders closed by default and expose only the formats in the product contract.
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({ operation: ["VipsForeignLoadJpegBuffer", "VipsForeignLoadPngBuffer", "VipsForeignLoadWebpBuffer"] });

export { sharp };
export type { Metadata };
