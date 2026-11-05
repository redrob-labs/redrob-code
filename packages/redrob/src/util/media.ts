const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)

export function isPdfAttachment(mime: string) {
  return mime === "application/pdf"
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isPdfAttachment(mime)
}

export function isImageAttachment(mime: string) {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

export function sniffAttachmentMime(bytes: Uint8Array, fallback: string) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp"
  }

  return fallback
}


/** OOXML documents whose text the engine extracts instead of sending the file to the provider. */
export type OfficeKind = "docx" | "xlsx" | "pptx"

const OFFICE_MIMES: Record<string, OfficeKind> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
}

const OFFICE_EXTENSIONS: Record<string, OfficeKind> = { ".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx" }

export function isOfficeDocument(mime: string) {
  return mime in OFFICE_MIMES
}

/** The OOXML kind of a file, by mime first and then by extension. */
export function officeKind(filepath: string, mime?: string): OfficeKind | undefined {
  if (mime && OFFICE_MIMES[mime]) return OFFICE_MIMES[mime]
  const dot = filepath.lastIndexOf(".")
  if (dot < 0) return undefined
  return OFFICE_EXTENSIONS[filepath.slice(dot).toLowerCase()]
}
