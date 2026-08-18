"use client";

import { isImageFile, isVideoFile, isAudioFile, isPdfFile, isDocxFile, isSheetFile } from "../constants/fileExplorer.js";
import ImageViewer from "./ImageViewer.js";
import MediaViewer from "./MediaViewer.js";
import OfficeViewer from "./OfficeViewer.js";
import PdfViewer from "./PdfViewer.js";

// True when the file is one a text editor cannot usefully open. Callers check this
// before loading, because readFile refuses binary content outright.
export const isPreviewable = (filePath) =>
  isImageFile(filePath) || isVideoFile(filePath) || isAudioFile(filePath) ||
  isPdfFile(filePath) || isDocxFile(filePath) || isSheetFile(filePath);

// Picks the viewer a non-text file needs. Keyed on filePath so switching files remounts
// rather than feeding a new source to a player still holding the old one.
export default function FilePreview({ filePath, fileSocket }) {
  if (isPdfFile(filePath)) return <PdfViewer key={filePath} filePath={filePath} fileSocket={fileSocket} />;
  if (isDocxFile(filePath) || isSheetFile(filePath)) return <OfficeViewer key={filePath} filePath={filePath} fileSocket={fileSocket} />;
  if (isVideoFile(filePath) || isAudioFile(filePath)) return <MediaViewer key={filePath} filePath={filePath} fileSocket={fileSocket} />;
  return <ImageViewer key={filePath} filePath={filePath} fileSocket={fileSocket} />;
}
