const {Plugin, Setting, showMessage, fetchSyncPost} = require("siyuan");

const STORAGE_NAME = "settings.json";
const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    widthPercent: 50,
    maxHeightPx: 0,
    debug: false,
});

const SCAN_INTERVAL = 250;
const PASTE_TIMEOUT = 20000;
const MAX_IDLE_SCANS = 40;
const MAX_PENDING_TASKS = 20;
// 图片两侧的空格会让实际占用宽度略大于百分比，与思源自身缩放时采用的固定间隙一致
const INLINE_GAP_PX = 8;
// 同一段落写回后的冷却时间，避免多个任务对着同一段落反复写
const WRITE_COOLDOWN = 1200;

// 这些块没有可独立更新的段落，或者整块更新风险过高，直接跳过
const SKIP_BLOCK_TYPES = new Set([
    "NodeTable",
    "NodeAttributeView",
    "NodeHTMLBlock",
    "NodeCodeBlock",
]);

module.exports = class PasteImageWidth extends Plugin {
    async onload() {
        this.disposed = false;
        this.tasks = new Set();
        this.activeBlocks = new Set();
        this.settingInputs = {};
        this.debugLines = [];
        this.debugTimer = null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS);

        await this.loadSettings();
        this.initSetting();

        this.onPasteEvent = (event) => {
            try {
                this.handlePaste(event);
            } catch (error) {
                console.warn("[paste-image-width] paste handler failed", error);
            }
        };
        document.addEventListener("paste", this.onPasteEvent, true);

        this.addCommand({
            langKey: "openSetting",
            callback: () => {
                if (!this.disposed) {
                    this.openSetting();
                }
            },
        });
    }

    onunload() {
        this.disposed = true;
        if (this.debugTimer) {
            window.clearTimeout(this.debugTimer);
            this.debugTimer = null;
        }
        void this.flushDebug();
        if (this.onPasteEvent) {
            document.removeEventListener("paste", this.onPasteEvent, true);
            this.onPasteEvent = null;
        }
        this.tasks.forEach((task) => {
            task.cancelled = true;
            if (task.timer) {
                clearTimeout(task.timer);
                task.timer = null;
            }
        });
        this.tasks.clear();
        this.activeBlocks.clear();
        this.settingInputs = {};
    }

    /* ---------------- 设置 ---------------- */

    async loadSettings() {
        let raw = null;
        try {
            raw = await this.loadData(STORAGE_NAME);
        } catch (error) {
            console.warn("[paste-image-width] loadData failed", error);
        }
        this.settings = this.normalizeSettings(raw);
    }

    normalizeSettings(raw) {
        let data = raw;
        if (typeof raw === "string") {
            try {
                data = raw.trim() ? JSON.parse(raw) : null;
            } catch (error) {
                data = null;
            }
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            data = {};
        }
        return {
            enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_SETTINGS.enabled,
            widthPercent: this.clampNumber(data.widthPercent, 1, 100, DEFAULT_SETTINGS.widthPercent),
            maxHeightPx: Math.round(this.clampNumber(data.maxHeightPx, 0, 20000, DEFAULT_SETTINGS.maxHeightPx)),
            debug: typeof data.debug === "boolean" ? data.debug : DEFAULT_SETTINGS.debug,
        };
    }

    clampNumber(value, min, max, fallback) {
        const num = Number(value);
        if (!Number.isFinite(num)) {
            return fallback;
        }
        return Math.min(max, Math.max(min, num));
    }

    initSetting() {
        this.settingInputs = {};
        this.setting = new Setting({
            confirmCallback: async () => {
                await this.saveSettingFromInputs();
            },
        });

        this.setting.addItem({
            title: this.i18n.enableTitle,
            description: this.i18n.enableDesc,
            createActionElement: () => {
                const input = document.createElement("input");
                input.type = "checkbox";
                input.className = "b3-switch fn__flex-center";
                input.checked = this.settings.enabled;
                this.settingInputs.enabled = input;
                return input;
            },
        });

        this.setting.addItem({
            title: this.i18n.widthTitle,
            description: this.i18n.widthDesc,
            createActionElement: () => {
                const input = document.createElement("input");
                input.type = "number";
                input.min = "1";
                input.max = "100";
                input.step = "1";
                input.className = "b3-text-field paste-image-width-number";
                input.value = String(this.settings.widthPercent);
                this.settingInputs.widthPercent = input;
                return input;
            },
        });

        this.setting.addItem({
            title: this.i18n.maxHeightTitle,
            description: this.i18n.maxHeightDesc,
            createActionElement: () => {
                const input = document.createElement("input");
                input.type = "number";
                input.min = "0";
                input.max = "20000";
                input.step = "10";
                input.className = "b3-text-field paste-image-width-number";
                input.value = String(this.settings.maxHeightPx);
                this.settingInputs.maxHeightPx = input;
                return input;
            },
        });

        this.setting.addItem({
            title: this.i18n.debugTitle,
            description: this.i18n.debugDesc,
            createActionElement: () => {
                const input = document.createElement("input");
                input.type = "checkbox";
                input.className = "b3-switch fn__flex-center";
                input.checked = this.settings.debug;
                this.settingInputs.debug = input;
                return input;
            },
        });
    }

    async saveSettingFromInputs() {
        const enabledInput = this.settingInputs.enabled;
        const widthInput = this.settingInputs.widthPercent;
        const heightInput = this.settingInputs.maxHeightPx;

        const enabled = enabledInput ? Boolean(enabledInput.checked) : this.settings.enabled;
        const widthValue = widthInput ? Number(widthInput.value) : this.settings.widthPercent;
        if (!Number.isFinite(widthValue) || widthValue < 1 || widthValue > 100) {
            showMessage(this.i18n.invalidWidth, 6000, "error");
            throw new Error("invalid width percent");
        }
        const widthPercent = Math.round(widthValue * 100) / 100;

        let maxHeightPx = 0;
        if (heightInput) {
            const heightValue = Number(heightInput.value);
            if (Number.isFinite(heightValue) && heightValue > 0) {
                maxHeightPx = Math.round(Math.min(20000, heightValue));
            }
        }

        const debugInput = this.settingInputs.debug;
        const debug = debugInput ? Boolean(debugInput.checked) : this.settings.debug;

        const next = {enabled, widthPercent, maxHeightPx, debug};
        let response = null;
        try {
            response = await this.saveData(STORAGE_NAME, next);
        } catch (error) {
            console.warn("[paste-image-width] saveData failed", error);
            showMessage(this.i18n.saveFailed, 6000, "error");
            throw error;
        }
        if (!response || response.code !== 0) {
            showMessage(this.i18n.saveFailed, 6000, "error");
            throw new Error("saveData rejected");
        }

        this.settings = next;
        if (widthInput) {
            widthInput.value = String(widthPercent);
        }
        if (heightInput) {
            heightInput.value = String(maxHeightPx);
        }
        showMessage(this.i18n.saved);
    }

    log(...args) {
        if (!this.settings || !this.settings.debug) {
            return;
        }
        console.log("[paste-image-width]", ...args);
        try {
            const parts = args.map((item) => {
                if (typeof item === "string") {
                    return item;
                }
                try {
                    return JSON.stringify(item);
                } catch (error) {
                    return String(item);
                }
            });
            this.debugLines.push(`${new Date().toISOString().slice(11, 23)} ${parts.join(" ")}`);
            if (this.debugLines.length > 300) {
                this.debugLines.splice(0, this.debugLines.length - 300);
            }
            this.scheduleDebugFlush();
        } catch (error) {
            // 日志失败不影响主流程
        }
    }

    scheduleDebugFlush() {
        if (this.debugTimer) {
            return;
        }
        this.debugTimer = window.setTimeout(() => {
            this.debugTimer = null;
            void this.flushDebug();
        }, 1000);
    }

    async flushDebug() {
        if (!this.debugLines || !this.debugLines.length) {
            return;
        }
        const content = this.debugLines.join("\n");
        try {
            await this.saveData("debug.log", content);
        } catch (error) {
            console.warn("[paste-image-width] save debug log failed", error);
        }
    }

    /* ---------------- 粘贴处理 ---------------- */

    handlePaste(event) {
        if (this.disposed || !this.settings.enabled || !event) {
            return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        // 3.8.x 下 protyle.querySelector(".protyle-wysiwyg") 可能拿到已被替换或为空的容器，
        // 因此优先使用事件目标所在的编辑区，并保留所属 .protyle 供扫描与光标恢复
        const editor = target.closest(".protyle-wysiwyg");
        const protyleElement = target.closest(".protyle") || (editor ? editor.closest(".protyle") : null);
        if (!editor && !protyleElement) {
            return;
        }
        const clipboardData = event.clipboardData;
        if (!clipboardData || !this.clipboardHasImages(clipboardData)) {
            return;
        }
        this.log("paste detected");
        this.startTask(protyleElement || editor);
    }

    clipboardHasImages(clipboardData) {
        const files = clipboardData.files ? Array.from(clipboardData.files) : [];
        if (files.some((file) => this.isImageFile(file))) {
            return true;
        }
        const items = clipboardData.items ? Array.from(clipboardData.items) : [];
        if (items.some((item) => item.kind === "file" && (item.type || "").startsWith("image/"))) {
            return true;
        }
        return ["text/html", "text/siyuan", "text/plain"].some((type) => {
            const text = clipboardData.getData(type);
            return typeof text === "string" && /<img[\s>]/i.test(text);
        });
    }

    isImageFile(file) {
        if (!file) {
            return false;
        }
        if ((file.type || "").startsWith("image/")) {
            return true;
        }
        return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|tiff?)$/i.test(file.name || "");
    }

    startTask(scope) {
        if (this.disposed || !this.settings.enabled) {
            return;
        }
        if (this.tasks.size >= MAX_PENDING_TASKS) {
            console.warn("[paste-image-width] too many pending paste tasks, skip");
            return;
        }
        const now = Date.now();
        const protyleElement = this.resolveProtyle(scope);
        // 连续粘贴由仍在运行的同一个任务覆盖，避免重复写入
        for (const task of this.tasks) {
            if (task.protyleElement === protyleElement && now - task.startedAt < 1500) {
                return;
            }
        }

        const existingElements = new WeakSet();
        const existingSrcCounts = new Map();
        let imageCount = 0;
        this.collectEditors(protyleElement).forEach((editor) => {
            editor.querySelectorAll("img").forEach((img) => {
                imageCount += 1;
                existingElements.add(img);
                const src = this.getImageSource(img);
                if (src) {
                    existingSrcCounts.set(src, (existingSrcCounts.get(src) || 0) + 1);
                }
            });
        });

        const task = {
            protyleElement,
            existingElements,
            existingSrcCounts,
            settled: new WeakSet(),
            blockCooldown: new Map(),
            loggedIdle: false,
            startedAt: now,
            deadline: now + PASTE_TIMEOUT,
            idle: 0,
            busy: false,
            cancelled: false,
            timer: null,
        };
        this.log("task start", {images: imageCount});
        this.tasks.add(task);
        this.scheduleScan(task);
    }

    scheduleScan(task) {
        if (this.disposed || task.cancelled) {
            return;
        }
        task.timer = setTimeout(() => {
            task.timer = null;
            this.scan(task).catch((error) => {
                console.warn("[paste-image-width] scan failed", error);
            });
        }, SCAN_INTERVAL);
    }

    async scan(task) {
        if (this.disposed || task.cancelled) {
            return;
        }
        if (Date.now() > task.deadline) {
            this.finishTask(task);
            return;
        }
        if (task.busy) {
            this.scheduleScan(task);
            return;
        }

        task.busy = true;
        let foundAny = false;
        const groups = new Map();
        try {
            // 每轮扫描重新取当前连在文档上的编辑区，避免沿用被思源替换掉的旧节点
            const images = [];
            this.collectEditors(task.protyleElement).forEach((editor) => {
                editor.querySelectorAll("img").forEach((img) => images.push(img));
            });
            const liveCounts = new Map();
            images.forEach((img) => {
                const src = this.getImageSource(img);
                if (src) {
                    liveCounts.set(src, (liveCounts.get(src) || 0) + 1);
                }
            });
            images.forEach((img) => {
                const src = this.getImageSource(img);
                if (!src || src.startsWith("data:") || src.startsWith("blob:")) {
                    return;
                }
                if (task.existingElements.has(img)) {
                    return;
                }
                // 同一资源路径可能被重复粘贴，因此比较当前数量与粘贴前数量，而不是只看路径
                const before = task.existingSrcCounts.get(src) || 0;
                if ((liveCounts.get(src) || 0) - before <= 0) {
                    return;
                }
                if (task.settled.has(img)) {
                    return;
                }
                if (this.hasSizeStyle(img)) {
                    task.settled.add(img);
                    return;
                }
                const blockElement = img.closest("[data-node-id]");
                const blockId = this.getBlockId(img);
                if (!blockId || !blockElement) {
                    return;
                }
                if (!groups.has(blockId)) {
                    groups.set(blockId, {
                        sources: new Set(),
                        counts: new Map(),
                        elements: new Set(),
                        element: blockElement,
                    });
                }
                const group = groups.get(blockId);
                group.sources.add(src);
                group.counts.set(src, (group.counts.get(src) || 0) + 1);
                group.elements.add(img);
            });
            if (groups.size === 0 && !task.loggedIdle) {
                task.loggedIdle = true;
                this.log("scan: no new image", {images: images.length});
            }

            for (const [blockId, group] of groups) {
                if (this.activeBlocks.has(blockId)) {
                    continue;
                }
                const lastWrite = task.blockCooldown.get(blockId) || 0;
                if (Date.now() - lastWrite < WRITE_COOLDOWN) {
                    continue;
                }
                const caretInside = this.isCaretInside(group.element);
                this.activeBlocks.add(blockId);
                let outcome = "error";
                try {
                    outcome = await this.applyToBlock(blockId, group, task);
                } finally {
                    this.activeBlocks.delete(blockId);
                }
                if (this.disposed || task.cancelled) {
                    return;
                }
                this.log("block result", {
                    blockId,
                    outcome,
                    counts: Array.from(group.counts.entries()),
                });
                if (outcome === "applied" || outcome === "skipped") {
                    task.blockCooldown.set(blockId, Date.now());
                    group.elements.forEach((element) => task.settled.add(element));
                }
                if (outcome === "applied") {
                    foundAny = true;
                    if (caretInside) {
                        this.restoreCaret(task, blockId, group.sources);
                    }
                }
            }
        } finally {
            task.busy = false;
        }

        if (foundAny) {
            task.idle = 0;
        } else {
            task.idle += 1;
        }
        if (task.idle >= MAX_IDLE_SCANS) {
            this.finishTask(task);
            return;
        }
        this.scheduleScan(task);
    }

    async applyToBlock(blockId, group, task) {
        let domResponse = null;
        try {
            domResponse = await fetchSyncPost("/api/block/getBlockDOM", {id: blockId});
        } catch (error) {
            console.warn("[paste-image-width] getBlockDOM failed", error);
            return "error";
        }
        if (this.disposed || task.cancelled) {
            return "error";
        }
        if (!domResponse || domResponse.code !== 0 || !domResponse.data || !domResponse.data.dom) {
            return "error";
        }

        const container = document.createElement("div");
        container.innerHTML = domResponse.data.dom;
        const sources = group.sources;
        const kernelCounts = new Map();
        container.querySelectorAll("img").forEach((img) => {
            const src = this.getImageSource(img);
            if (src) {
                kernelCounts.set(src, (kernelCounts.get(src) || 0) + 1);
            }
        });
        for (const [src, count] of group.counts) {
            if ((kernelCounts.get(src) || 0) < count) {
                // 内核内容还没包含最新粘贴的图片，稍后重试，避免写回时把它们覆盖掉
                this.log("stale, retry later", {blockId, src, need: count, have: kernelCounts.get(src) || 0});
                return "stale";
            }
        }
        this.log("applyToBlock", {
            blockId,
            kernelCounts: Array.from(kernelCounts.entries()),
            groupCounts: Array.from(group.counts.entries()),
        });
        let matched = 0;
        let changed = 0;
        container.querySelectorAll("img").forEach((img) => {
            const src = this.getImageSource(img);
            if (!src || !sources.has(src)) {
                return;
            }
            matched += 1;
            if (this.hasSizeStyle(img)) {
                return;
            }
            this.applySizeStyle(img);
            changed += 1;
        });
        if (matched === 0) {
            this.log("no image matched in kernel DOM", {blockId});
            return "no-match";
        }
        this.log("write plan", {blockId, matched, changed});
        if (changed === 0) {
            return "skipped";
        }

        let updateResponse = null;
        try {
            updateResponse = await fetchSyncPost("/api/block/updateBlock", {
                id: blockId,
                dataType: "dom",
                data: container.innerHTML,
            });
        } catch (error) {
            console.warn("[paste-image-width] updateBlock failed", error);
            return "error";
        }
        if (this.disposed || task.cancelled) {
            return "error";
        }
        this.log("write result", {blockId, code: updateResponse ? updateResponse.code : null});
        if (!updateResponse || updateResponse.code !== 0) {
            console.warn("[paste-image-width] updateBlock rejected", updateResponse);
            return "error";
        }
        return "applied";
    }

    finishTask(task) {
        task.cancelled = true;
        if (task.timer) {
            clearTimeout(task.timer);
            task.timer = null;
        }
        this.tasks.delete(task);
    }

    /* ---------------- 工具方法 ---------------- */

    getBlockId(element) {
        const blockElement = element.closest("[data-node-id]");
        if (!blockElement) {
            return null;
        }
        const type = blockElement.getAttribute("data-type") || "";
        if (SKIP_BLOCK_TYPES.has(type)) {
            return null;
        }
        if (blockElement.closest(".table")) {
            return null;
        }
        return blockElement.getAttribute("data-node-id") || null;
    }

    getImageSource(img) {
        const src = img.getAttribute("data-src") || img.getAttribute("src") || "";
        return src.trim();
    }

    // 思源图片结构：span[data-type="img"] > span(空格) + span(尺寸) + span(空格)，
    // 只有直接包裹 img 的那层 span 才是存放 width / max-height 的位置
    getImageHolder(img) {
        const wrapper = img.closest('[data-type~="img"]');
        if (wrapper) {
            let element = img.parentElement;
            while (element && element !== wrapper) {
                if (element.tagName === "SPAN") {
                    return element;
                }
                element = element.parentElement;
            }
        }
        return img.parentElement && img.parentElement.tagName === "SPAN" ? img.parentElement : null;
    }

    resolveProtyle(scope) {
        if (!scope) {
            return null;
        }
        if (scope.classList && scope.classList.contains("protyle-wysiwyg")) {
            return scope.closest(".protyle");
        }
        if (scope.classList && scope.classList.contains("protyle")) {
            return scope;
        }
        return scope.closest ? scope.closest(".protyle") : null;
    }

    // 重新解析当前仍连接在文档上的编辑区；只有所属 protyle 已失效时才退回到全文档
    collectEditors(protyleElement) {
        const editors = [];
        const seen = new Set();
        const push = (element) => {
            if (element && element.isConnected && element.querySelectorAll && !seen.has(element)) {
                seen.add(element);
                editors.push(element);
            }
        };
        if (protyleElement && protyleElement.isConnected) {
            protyleElement.querySelectorAll(".protyle-wysiwyg").forEach(push);
            if (protyleElement.classList && protyleElement.classList.contains("protyle-wysiwyg")) {
                push(protyleElement);
            }
            if (editors.length > 0) {
                return editors;
            }
        }
        document.querySelectorAll(".protyle-wysiwyg").forEach(push);
        return editors;
    }

    findBlockElement(blockId, protyleElement) {
        const selector = `[data-node-id="${blockId}"]`;
        const editors = this.collectEditors(protyleElement);
        for (const editor of editors) {
            const element = editor.querySelector(selector);
            if (element) {
                return element;
            }
        }
        return null;
    }

    hasSizeStyle(img) {
        const candidates = [img];
        const holder = this.getImageHolder(img);
        if (holder) {
            candidates.push(holder);
        }
        const wrapper = img.closest('[data-type~="img"]');
        if (wrapper) {
            candidates.push(wrapper);
            Array.from(wrapper.children).forEach((child) => candidates.push(child));
        }
        return candidates.some((element) => {
            const style = element ? element.style : null;
            return Boolean(style && (style.width || style.height || style.maxWidth || style.maxHeight));
        });
    }

    applySizeStyle(img) {
        const widthPercent = this.settings.widthPercent;
        const maxHeightPx = this.settings.maxHeightPx;
        // 思源把图片尺寸写在 span[data-type="img"] 内层的包裹 span 上，写在 img 上不会被保留
        const styleElement = this.getImageHolder(img) || img;
        const style = styleElement.style;
        const widthValue = widthPercent >= 100 ? "100%" : `calc(${widthPercent}% - ${INLINE_GAP_PX}px)`;
        [img, styleElement].forEach((element) => {
            if (!element || !element.style) {
                return;
            }
            element.style.removeProperty("height");
            element.style.removeProperty("max-height");
            element.style.removeProperty("max-width");
            element.style.removeProperty("width");
        });
        if (maxHeightPx > 0) {
            // 等比缩放：按原尺寸排版，同时受宽度占比和高度上限约束
            style.setProperty("width", "auto");
            style.setProperty("max-width", widthValue);
            style.setProperty("max-height", `${maxHeightPx}px`);
        } else {
            style.setProperty("width", widthValue);
        }
    }

    isCaretInside(blockElement) {
        if (!blockElement) {
            return false;
        }
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return false;
        }
        const anchor = selection.anchorNode;
        return Boolean(anchor && blockElement.contains(anchor));
    }

    isCaretAtBlockStart(editable) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return false;
        }
        const range = selection.getRangeAt(0);
        if (!range.collapsed) {
            return false;
        }
        const start = document.createRange();
        start.selectNodeContents(editable);
        start.collapse(true);
        try {
            return range.compareBoundaryPoints(Range.START_TO_START, start) === 0;
        } catch (error) {
            return false;
        }
    }

    restoreCaret(task, blockId, sources) {
        let attempts = 0;
        const place = () => {
            if (this.disposed || task.cancelled) {
                return;
            }
            const blockElement = this.findBlockElement(blockId, task.protyleElement);
            const editable = blockElement ?
                (blockElement.querySelector('[contenteditable="true"]') ||
                    blockElement.querySelector("[spellcheck]")) : null;
            if (!blockElement || !editable) {
                retry();
                return;
            }
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0) {
                retry();
                return;
            }
            const anchor = selection.anchorNode;
            const caretInBlock = Boolean(anchor && blockElement.contains(anchor));
            const active = document.activeElement;
            const editorElement = blockElement.closest(".protyle-wysiwyg");
            const focusInEditor = Boolean(active && editorElement &&
                (active === editorElement || editorElement.contains(active)));
            if (!focusInEditor && !caretInBlock) {
                // 用户已离开编辑器，不抢焦点
                return;
            }
            // 只在光标被重置到段首时才修正，避免打断用户自己的定位
            if (caretInBlock && !this.isCaretAtBlockStart(editable)) {
                return;
            }
            const images = Array.from(blockElement.querySelectorAll("img")).reverse();
            let target = null;
            for (const image of images) {
                const src = this.getImageSource(image);
                if (src && sources.has(src)) {
                    target = image;
                    break;
                }
            }
            if (!target) {
                retry();
                return;
            }
            const wrapper = target.closest('[data-type~="img"]') || target;
            try {
                const range = document.createRange();
                range.setStartAfter(wrapper);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                this.log("caret restored", {blockId});
                if (!focusInEditor) {
                    editable.focus({preventScroll: true});
                }
            } catch (error) {
                console.warn("[paste-image-width] restore caret failed", error);
            }
        };
        const retry = () => {
            if (this.disposed || task.cancelled || attempts >= 6) {
                return;
            }
            attempts += 1;
            window.setTimeout(place, 150 + attempts * 180);
        };
        window.setTimeout(place, 120);
    }
};
