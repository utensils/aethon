/**
 * FileIcon — renders the right vendored SVG for a file or folder.
 *
 * Resolves via `iconForPath` (src/file-icons) and renders an inline
 * <img>. Sized in CSS via the `.ae-file-icon` class — pass any size
 * via the `size` prop or override with CSS.
 */

import { iconForPath } from "../file-icons";

export interface FileIconProps {
  path: string;
  isDir: boolean;
  open?: boolean;
  isRoot?: boolean;
  size?: number;
  className?: string;
  ariaHidden?: boolean;
}

export function FileIcon({
  path,
  isDir,
  open,
  isRoot,
  size = 16,
  className,
  ariaHidden = true,
}: FileIconProps) {
  const icon = iconForPath(path, isDir, { open, isRoot });
  return (
    <img
      src={icon.src}
      width={size}
      height={size}
      aria-hidden={ariaHidden || undefined}
      className={`ae-file-icon${className ? ` ${className}` : ""}`}
      alt=""
      draggable={false}
    />
  );
}
