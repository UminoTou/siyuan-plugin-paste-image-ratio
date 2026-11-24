# Paste Image Default Size

**English** | [简体中文](https://github.com/UminoTou/siyuan-plugin-paste-image-ratio/blob/main/README.zh_CN.md)

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

## Compatibility

Requires SiYuan 3.8.7 or later (the `minAppVersion` in `plugin.json`); tested on 3.8.11.

SiYuan 3.8.10 introduced rich document titles. The title area now hosts its own protyle-lite fragment, which contains a `.protyle-wysiwyg` element placed **before** the body editor. Version 1.0.0 resolved the editor with `protyle.querySelector(".protyle-wysiwyg")` — that returns the first match in document order, so on 3.8.10+ it picked up the empty title editor, found zero images, and gave up after the 10-second scan without any message.

Version 1.0.1 resolves the editor from the paste event target instead (`target.closest(".protyle-wysiwyg")`), which does not depend on DOM order. Earlier versions have no title editor, so the same lookup lands on the body editor exactly as before.

## Known limitations

- The width subtracts an 8px inline gap, the same convention SiYuan uses when resizing images, so 20% fits 5 images per row and 50% fits 2; a single image is 8px narrower
- Exported Markdown does not carry image sizes, which is a limitation of SiYuan's Markdown export

## Changelog

### 1.0.1

- Fixed: pasting an image did nothing on SiYuan 3.8.10+, because the editor was resolved to the editor inside the rich title
- Fixed: the size style is now written to the span that actually stores it inside `span[data-type="img"]`, so it survives a DOM refresh
- Fixed: caret restore now looks up the editor from the target block instead of reusing a cached editor node

## Data and privacy

The plugin only calls local kernel APIs to read and update the paragraph containing the pasted image. Settings are stored in `data/storage/petal/siyuan-plugin-paste-image-ratio/settings.json`. No network access, no data uploaded.

## Targeted Poverty Alleviation Channel

![WeChat / Alipay donation QR codes](images/donate-qr.png)
