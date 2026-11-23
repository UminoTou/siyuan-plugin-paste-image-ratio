# Paste Image Default Size

A SiYuan desktop plugin that applies a default width ratio (with an optional height cap) to images you paste into the editor, so you don't have to resize them by hand every time.

## Features

- After pasting an image (clipboard image, image file, HTML containing `<img>`, or an internal SiYuan copy), the new image width is set to the configured percentage, 50% by default
- The size is written as the image's own style, the same representation used by SiYuan's image width menu, so it is stored with the note and kept in HTML/PDF exports
- Optional height cap in pixels; when enabled, images scale down proportionally and are never stretched or upscaled
- Images that already have a width or height style are left untouched; images inside table cells are skipped
- Only newly pasted images are processed; existing notes are not modified

## Usage

1. Enable the plugin and paste an image in any document
2. Change the size in `Settings` → `Bazaar` → `Downloaded` → `Plugins`, or run the command "Open paste image size settings" from the command palette

| Setting | Description |
| --- | --- |
| Apply default size to pasted images | Master switch, enabled by default |
| Width ratio (%) | Percentage of the editor width, 1-100, default 50 |
| Height cap (px) | 0 means no limit; when greater than 0, images scale down proportionally |
| Debug logging | Off by default; writes logs to the console and the plugin storage folder for troubleshooting |

## Known limitations

- The width subtracts an 8px inline gap, the same convention SiYuan uses when resizing images, so 20% fits 5 images per row and 50% fits 2; a single image is 8px narrower
- Exported Markdown does not carry image sizes, which is a limitation of SiYuan's Markdown export

## Data and privacy

The plugin only calls local kernel APIs to read and update the paragraph containing the pasted image. Settings are stored in `data/storage/petal/siyuan-plugin-paste-image-ratio/settings.json`. No network access, no data uploaded.

## Targeted Poverty Alleviation Channel

If this plugin saved you from dragging every pasted image to the right width, feel free to scan the codes and buy me a coffee.

![WeChat / Alipay donation QR codes](images/donate-qr.png)
