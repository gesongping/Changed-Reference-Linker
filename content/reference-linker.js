/* Reference Linker author-year extended bundle; TypeScript compiled */
(function(){
"use strict";
const modules = Object.create(null);
modules["src/index.ts"]=function(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startup = startup;
exports.shutdown = shutdown;
const ReaderIntegration_1 = require("./reader/ReaderIntegration");
let integration;
async function startup({ pluginID, Zotero }) {
    integration = new ReaderIntegration_1.ReaderIntegration(Zotero, pluginID);
    integration.start();
    Zotero.debug("Reference Linker started");
}
async function shutdown() {
    integration?.stop();
    integration = undefined;
}

};
modules["src/reader/ReaderIntegration.ts"]=function(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReaderIntegration = void 0;
const CitationParser_1 = require("../core/CitationParser");
const LibraryMatcher_1 = require("../core/LibraryMatcher");
const PdfSectionExtractor_1 = require("../core/PdfSectionExtractor");
const ReferenceOverlay_1 = require("./ReferenceOverlay");
class ReaderIntegration {
    zotero;
    pluginID;
    states = new WeakMap();
    readers = new Set();
    parser = new CitationParser_1.CitationParser();
    sectionExtractor = new PdfSectionExtractor_1.PdfSectionExtractor();
    matcherCache = new Map();
    toolbarHandler = (event) => this.onToolbar(event);
    constructor(zotero, pluginID) {
        this.zotero = zotero;
        this.pluginID = pluginID;
    }
    start() {
        this.zotero.Reader.registerEventListener("renderToolbar", this.toolbarHandler, this.pluginID);
    }
    stop() {
        this.zotero.Reader.unregisterEventListener("renderToolbar", this.toolbarHandler);
        for (const reader of this.readers)
            this.destroyReader(reader);
        this.readers.clear();
    }
    onToolbar({ reader, doc, append }) {
        if (!doc || !append)
            return;
        this.installToolbarStyle(doc);
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "toolbar-button reference-linker-trigger";
        button.title = "重新扫描并匹配参考文献";
        button.setAttribute("aria-label", "重新扫描并匹配参考文献");
        const label = doc.createElement("span");
        label.className = "reference-linker-label";
        label.textContent = "Ref";
        const summary = this.createSummary(doc);
        button.append(label, summary);
        button.addEventListener("click", async () => {
            if (button.disabled) return;
            label.textContent = "···";
            button.disabled = true;
            try {
                await this.scan(reader, true, true);
            }
            catch (error) {
                this.zotero.logError(error);
                button.title = error instanceof Error ? error.message : String(error);
            }
            finally {
                label.textContent = "Ref";
                button.disabled = false;
            }
        });
        append(button);
        const state = this.states.get(reader) || { scanning: false };
        // The toolbar can be rendered again for the same reader; replace the old
        // stats reference without changing the overlay or scan state.
        state.summary = summary;
        this.states.set(reader, state);
        this.attach(reader);
    }
    attach(reader) {
        this.readers.add(reader);
        const state = this.states.get(reader) || { scanning: false };
        this.states.set(reader, state);
        const win = reader._iframeWindow;
        if (!win?.document?.documentElement || state.outerObserver)
            return;
        const Observer = win.MutationObserver;
        const observer = new Observer(() => {
            const viewer = this.getViewerDocument(reader);
            if (viewer && viewer !== state.viewerDocument) {
                this.observeViewer(reader, viewer);
                this.scheduleScan(reader);
            }
        });
        observer.observe(win.document.documentElement, { childList: true, subtree: true });
        state.outerObserver = observer;
        if (!state.unloadHandler) {
            state.unloadHandler = () => {
                this.destroyReader(reader);
                this.readers.delete(reader);
            };
            win.addEventListener("unload", state.unloadHandler, { once: true });
        }
        this.scheduleScan(reader, 1200);
    }
    scheduleScan(reader, delay = 500) {
        const state = this.states.get(reader);
        const win = reader._iframeWindow;
        if (!state || !win)
            return;
        if (state.timer)
            win.clearTimeout(state.timer);
        state.timer = win.setTimeout(() => void this.scan(reader, false), delay);
    }
    async scan(reader, reportEmpty, force = false) {
        const state = this.states.get(reader);
        const doc = this.getViewerDocument(reader);
        if (!state || !doc || state.scanning)
            return undefined;
        this.observeViewer(reader, doc);
        const fingerprint = this.pageFingerprint(doc);
        if (!force && state.fingerprint === fingerprint)
            return state.lastMatched;
        state.fingerprint = fingerprint;
        state.scanning = true;
        try {
            const section = await this.getReferenceSection(reader, state);
            if (!section) {
                if (reportEmpty)
                    this.zotero.debug("Reference Linker: no rendered References section found. Scroll to the references pages and retry.");
                return undefined;
            }
            const attachment = this.getAttachment(reader);
            if (!attachment)
                return undefined;
            const currentItemID = typeof attachment.parentID === "number" ? attachment.parentID : undefined;
            if (force)
                this.matcherCache.clear();
            const matcher = await this.getMatcher(attachment.libraryID);
            let otherLibraries;
            const crossLibraryMatcher = async () => {
                if (otherLibraries)
                    return otherLibraries;
                const libraryIDs = [...new Set((this.zotero.Libraries?.getAll() || [])
                        .map(library => library.libraryID)
                        .filter(id => Number.isInteger(id) && id !== attachment.libraryID))];
                if (!libraryIDs.length)
                    return undefined;
                const combined = new LibraryMatcher_1.LibraryMatcher(this.zotero);
                await combined.indexMany(libraryIDs);
                otherLibraries = combined;
                return combined;
            };
            if (!state.overlay || state.overlayDocument !== doc) {
                state.overlay?.destroy();
                state.overlay = new ReferenceOverlay_1.ReferenceOverlay(doc, match => void this.open(match.record.item.id, match.record.pdfAttachmentID), url => this.zotero.launchURL(url));
                state.overlayDocument = doc;
            }
            state.overlay.clear();
            state.overlay.indexPages(section.startPage, section.endPage, section.startHeading, section.endHeading);
            let matchedItems = 0;
            let ambiguousItems = 0;
            let unmatchedItems = 0;
            const references = section.references;
            for (const [position, reference] of references.entries()) {
                const citation = this.parser.parse(reference);
                let outcome = matcher.matchWithOutcome(citation);
                if (!outcome.match) {
                    try {
                        const fallback = await crossLibraryMatcher();
                        if (fallback) {
                            const other = fallback.matchWithOutcome(citation);
                            if (other.match)
                                outcome = other;
                            else if (other.ambiguous)
                                outcome = { ambiguous: true };
                        }
                    }
                    catch (error) {
                        this.zotero.debug(`Reference Linker: cross-library lookup unavailable: ${String(error)}`);
                    }
                }
                const match = outcome.match;
                const referenceKey = reference.index == null ? `reference:${position}` : `index:${reference.index}`;
                if (!match) {
                    if (outcome.ambiguous)
                        ambiguousItems++;
                    else
                        unmatchedItems++;
                    if (reference.index != null) {
                        state.overlay.renderIndexedUnmatched(reference.index, citation, referenceKey);
                    }
                    else {
                        state.overlay.renderTextUnmatched(reference.raw, citation.title, citation, referenceKey);
                    }
                    continue;
                }
                matchedItems++;
                if (match.record.item.id === currentItemID)
                    continue;
                reference.index != null
                    ? state.overlay.renderIndexed(reference.index, match, referenceKey)
                    : state.overlay.renderText(reference.raw, citation.title, match, referenceKey);
            }
            const linked = state.overlay.linkCount();
            this.updateSummary(state, {
                scanned: references.length,
                matched: matchedItems,
                ambiguous: ambiguousItems,
                unmatched: unmatchedItems
            });
            this.zotero.debug(`Reference Linker: ${linked} links rendered; ${matchedItems} library items matched; source=${section.source}`);
            state.lastMatched = linked;
            return linked;
        }
        catch (error) {
            this.zotero.logError(error);
            throw error;
        }
        finally {
            state.scanning = false;
        }
    }
    getReferenceSection(reader, state) {
        if (!state.sectionPromise) {
            const pdf = this.getPdfDocument(reader);
            if (!pdf)
                return Promise.resolve(undefined);
            state.sectionPromise = this.sectionExtractor.extract(pdf);
            state.sectionPromise.catch(() => { state.sectionPromise = undefined; });
        }
        return state.sectionPromise;
    }
    installToolbarStyle(doc) {
        if (doc.getElementById("reference-linker-toolbar-style"))
            return;
        const style = doc.createElement("style");
        style.id = "reference-linker-toolbar-style";
        style.textContent = `
      .reference-linker-trigger {
        display: inline-flex !important;
        align-items: center;
        justify-content: center;
        gap: 8px;
        height: 36px;
        width: auto !important;
        min-width: 106px;
        padding: 2px 7px !important;
        font-family: system-ui, sans-serif !important;
        font-weight: 500;
        color: var(--fill-primary, var(--color-text, inherit));
      }
      .reference-linker-label {
        font-size: 13px;
        line-height: 1;
        flex-shrink: 0;
      }
      .reference-linker-summary {
        display: grid;
        grid-template-columns: max-content max-content;
        column-gap: 3px;
        row-gap: 0;
        font-size: 10px;
        font-weight: 400;
        line-height: 1.15;
        white-space: nowrap;
        text-align: left;
        font-variant-numeric: tabular-nums;
        color: var(--fill-secondary, var(--color-text-secondary, currentColor));
      }
      .reference-linker-summary .reference-linker-number { text-align: right; }
    `;
        (doc.head || doc.documentElement).append(style);
    }
    createSummary(doc) {
        const summary = doc.createElement("span");
        summary.className = "reference-linker-summary";
        summary.setAttribute("aria-live", "polite");
        for (const [key, title] of [["scanned", "扫描"], ["matched", "匹配"], ["ambiguous", "模糊"]]) {
            const caption = doc.createElement("span");
            caption.textContent = title;
            const value = doc.createElement("span");
            value.className = `reference-linker-number reference-linker-${key}`;
            value.textContent = "—";
            summary.append(caption, value);
        }
        return summary;
    }
    updateSummary(state, counts) {
        if (!state.summary) return;
        for (const key of ["scanned", "matched", "ambiguous"]) {
            const node = state.summary.querySelector(`.reference-linker-${key}`);
            if (node) node.textContent = String(counts[key]);
        }
    }
    pageFingerprint(doc) {
        return Array.from(doc.querySelectorAll(".page")).map(page => {
            const spans = page.querySelectorAll(".textLayer span");
            const first = spans.item(0)?.textContent || "";
            const last = spans.item(spans.length - 1)?.textContent || "";
            return `${page.dataset.pageNumber || "?"}:${spans.length}:${first}:${last}`;
        }).join("|");
    }
    getPdfDocument(reader) {
        const internal = reader._internalReader;
        return internal?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument;
    }
    getMatcher(libraryID) {
        let pending = this.matcherCache.get(libraryID);
        if (!pending) {
            pending = (async () => {
                const matcher = new LibraryMatcher_1.LibraryMatcher(this.zotero);
                await matcher.index(libraryID);
                return matcher;
            })();
            this.matcherCache.set(libraryID, pending);
            pending.catch(() => this.matcherCache.delete(libraryID));
        }
        return pending;
    }
    getViewerDocument(reader) {
        const outer = reader._iframeWindow?.document;
        if (!outer)
            return undefined;
        const iframe = outer.querySelector("#primary-view > iframe, .primary-view > iframe");
        return iframe?.contentDocument || undefined;
    }
    observeViewer(reader, doc) {
        const state = this.states.get(reader);
        const win = doc.defaultView;
        if (!state || !win || state.viewerDocument === doc)
            return;
        state.viewerObserver?.disconnect();
        const Observer = win.MutationObserver;
        state.viewerObserver = new Observer(mutations => {
            const changedReaderContent = mutations.some(mutation => Array.from(mutation.addedNodes).some(node => !this.isOwnNode(node))
                || Array.from(mutation.removedNodes).some(node => !this.isOwnNode(node)));
            if (changedReaderContent)
                this.scheduleScan(reader);
        });
        state.viewerObserver.observe(doc.documentElement, { childList: true, subtree: true });
        state.viewerDocument = doc;
    }
    isOwnNode(node) {
        if (node.nodeType !== 1)
            return false;
        const element = node;
        return element.matches(".reference-linker-badge, .reference-linker-menu, #reference-linker-style")
            || Boolean(element.closest(".reference-linker-badge, .reference-linker-menu"));
    }
    getAttachment(reader) {
        const item = reader._item || (reader.itemID ? this.zotero.Items.get(reader.itemID) : false);
        return item && item.isAttachment() ? item : undefined;
    }
    async open(itemID, pdfAttachmentID) {
        if (pdfAttachmentID) {
            await this.zotero.Reader.open(pdfAttachmentID);
            return;
        }
        const pane = this.zotero.getMainWindow().ZoteroPane;
        await pane?.selectItem(itemID);
    }
    destroyReader(reader) {
        const state = this.states.get(reader);
        state?.outerObserver?.disconnect();
        state?.viewerObserver?.disconnect();
        state?.overlay?.destroy();
        state?.summary?.remove();
        const win = reader._iframeWindow;
        if (state?.timer && win)
            win.clearTimeout(state.timer);
        if (state?.unloadHandler && win)
            win.removeEventListener("unload", state.unloadHandler);
    }
}
exports.ReaderIntegration = ReaderIntegration;

};
modules["src/core/CitationParser.ts"]=function(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CitationParser = void 0;
const normalize_1 = require("./normalize");
const YEAR = /\b(19\d{2}|20\d{2})[a-z]?\b/i;
const CITATION_MARKER = /^\s*(?:\[\s*(?=[^\]\n]{0,24}\d)[A-Za-z0-9][A-Za-z0-9+.:/_\-\s]{0,23}\s*\]|\d+[.)]|\d+(?=\s+(?:[A-ZÀ-ÖØ-Þ](?:\.|\s)|Technical\b)))\s*/u;
const FULL_NAME_WORD = `(?:[A-ZÀ-ÖØ-Þ][\\p{L}'’-]+|[A-ZÀ-ÖØ-Þ]\\.?)`;
const FULL_NAME = `[A-ZÀ-ÖØ-Þ][\\p{L}'’-]+(?:\\s+${FULL_NAME_WORD}){1,4}`;
const INITIALS_AUTHOR = `(?:[A-ZÀ-ÖØ-Þ](?:-[A-ZÀ-ÖØ-Þ])?\\.\\s*){1,5}(?:(?:de|del|den|der|di|du|la|le|van|von)\\s+){0,3}[A-ZÀ-ÖØ-Þ][\\p{L}'’-]+`;
const COMMA_TITLE = new RegExp(`^(?:${INITIALS_AUTHOR}\\s*,\\s*)+(?:and\\s+${INITIALS_AUTHOR}\\s*,\\s*)?([^,]{12,240})\\s*,\\s*(?=[A-Z])`, "iu");
const FULL_NAME_LIST = new RegExp(`^${FULL_NAME}(?:,\\s*${FULL_NAME})*(?:,?\\s+(?:and|&)\\s+${FULL_NAME})?$`, "u");
const CONFERENCE_WORD = /\b(?:conference|workshop|symposium)\b|\bproc(?:eedings)?\.?(?=\s|,|$)/i;
const CONFERENCE_ACRONYM_AFTER_IN = /\bin\s+(?:the\s+)?(?:proc(?:eedings)?\.?\s+(?:of\s+)?(?:the\s+)?)?[A-Z][A-Z0-9&-]{2,}\b/;
const CONFERENCE_ACRONYM_WITH_YEAR = /\b[A-Z][A-Z0-9&/-]{2,}\s+(?:19|20)\d{2}[a-z]?\b/;
const BOOK_SECTION_CONTEXT = /\b(?:chapter|isbn)\b|\b(?:ed|eds|editor|editors)\.?\s*(?:[,;)]|$)|\b(?:academic\s+press|university\s+press|springer|elsevier|wiley|routledge|sage|palgrave|crc\s+press)\b/i;
class CitationParser {
    parse(reference) {
        const raw = reference.raw.replace(/[´`^¨]\s*/g, "").replace(/\s+/g, " ").trim();
        const yearMatch = raw.match(YEAR);
        const journal = this.extractJournalMetadata(raw, yearMatch);
        const title = journal?.titleless ? undefined : this.extractTitle(raw, yearMatch?.index);
        const containerTitle = journal?.containerTitle || this.extractContainerTitle(raw, title);
        return {
            raw,
            doi: (0, normalize_1.normalizeDOI)(raw),
            arxiv: (0, normalize_1.normalizeArxiv)(raw),
            title,
            normalizedTitle: title ? (0, normalize_1.normalizeTitle)(title) : undefined,
            containerTitle,
            normalizedContainerTitle: containerTitle ? (0, normalize_1.normalizeContainerTitle)(containerTitle) : undefined,
            year: yearMatch ? Number(yearMatch[1]) : undefined,
            firstAuthor: this.extractFirstAuthor(raw) || reference.firstAuthorHint,
            volume: journal?.volume,
            issue: journal?.issue,
            pages: journal?.pages,
            articleNumber: journal?.articleNumber,
            itemTypeHint: this.itemTypeHint(raw, title, containerTitle)
        };
    }
    extractFirstAuthor(raw) {
        const citation = raw.replace(CITATION_MARKER, "");
        const fullNameYear = citation.match(/^(.{3,180}?)\.\s+(?:18|19|20|21)\d{2}[a-z]?\s*\./iu);
        if (fullNameYear?.[1]) {
            const first = fullNameYear[1].split(/,\s*|\s+(?:and|&)\s+/iu)[0].trim();
            const pieces = first.split(/\s+/);
            if (pieces.length >= 2 && pieces.length <= 7)
                return (0, normalize_1.surname)(pieces.at(-1));
        }
        const vancouver = citation.match(/^([A-ZÀ-ÖØ-Þ][\p{L}'’-]+)\s+[A-Z]{1,4}(?=\s*[,;.])/u);
        if (vancouver?.[1])
            return (0, normalize_1.surname)(vancouver[1]);
        const surnameFirst = citation.match(/^((?:(?:[Dd]e|[Dd]el|[Dd]en|[Dd]er|[Dd]i|[Dd]u|[Ll]a|[Ll]e|[Vv]an|[Vv]on)\s+){0,3}[A-ZÀ-ÖØ-Þ][\p{L}'’-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'’-]+){0,2})\s*,/u);
        if (surnameFirst?.[1])
            return (0, normalize_1.surname)(surnameFirst[1]);
        const organization = citation.match(/^([^,]{1,80}\b(?:Collaboration|Partnership)\b)/i);
        if (organization?.[1])
            return (0, normalize_1.surname)(organization[1]);
        const initialsFirst = citation.match(/^(?:[A-ZÀ-ÖØ-Þ](?:[-.\s]+)){1,4}([A-ZÀ-ÖØ-Þ][\p{L}'’-]+)/u);
        if (initialsFirst?.[1])
            return (0, normalize_1.surname)(initialsFirst[1]);
        const etAl = citation.match(/^([A-ZÀ-ÖØ-Þ][\p{L}'’-]+)\s+et\s+al\b/u);
        if (etAl?.[1])
            return (0, normalize_1.surname)(etAl[1]);
        const fullNameFirst = citation.match(new RegExp(`^(${FULL_NAME})\\s*,`, "u"));
        if (fullNameFirst?.[1])
            return (0, normalize_1.surname)(fullNameFirst[1]);
        const fullNameBeforeAnd = citation.match(new RegExp(`^(${FULL_NAME})\\s+(?:and|&)\\s+`, "u"));
        if (fullNameBeforeAnd?.[1])
            return (0, normalize_1.surname)(fullNameBeforeAnd[1]);
        if (CITATION_MARKER.test(raw)) {
            const fullNameBeforePeriod = citation.match(new RegExp(`^(${FULL_NAME})\\.\\s+`, "u"));
            if (fullNameBeforePeriod?.[1])
                return (0, normalize_1.surname)(fullNameBeforePeriod[1]);
        }
        return undefined;
    }
    extractTitle(raw, yearIndex) {
        const authorYear = raw.match(/^.{3,180}?\.\s+(?:18|19|20|21)\d{2}[a-z]?\s*\.\s+(.+)/iu);
        if (authorYear?.[1]) {
            const remainder = authorYear[1];
            const boundary = remainder.search(/\.\s+(?=In\s|(?:arXiv|doi|https?):|Journal\s)/iu);
            const candidate = this.clean(boundary > 0 ? remainder.slice(0, boundary) : remainder.split(/\.\s+(?=[A-Z])/u)[0]);
            if (candidate.split(/\s+/).length >= 3)
                return candidate;
        }
        const quoted = raw.match(/[“\"]([^”\"]{12,300})[”\"]/);
        if (quoted?.[1])
            return this.clean(quoted[1]);
        const citation = raw.replace(CITATION_MARKER, "");
        const mathematicalTitle = this.extractCommaDelimitedTitle(citation);
        if (mathematicalTitle)
            return mathematicalTitle;
        const commaTitle = citation.match(COMMA_TITLE);
        if (commaTitle?.[1] && commaTitle[1].split(/\s+/).length >= 3)
            return this.clean(commaTitle[1]);
        const afterAuthors = this.extractAfterAuthors(citation);
        if (afterAuthors)
            return afterAuthors;
        const protectedCitation = citation.replace(/\b([A-Z])\.\s*/g, "$1\u0000");
        const segments = protectedCitation
            .split(/\.\s+(?=[A-Z\d])/)
            .map(value => this.clean(value.replace(/\u0000/g, ". ")))
            .filter(Boolean);
        const candidate = segments.find((segment, index) => {
            const words = segment.split(/\s+/).length;
            if (words < 3 || words > 40 || /^(doi|arxiv|vol|pp|https?|in\s+(proceedings|proc\.|conference|journal))/i.test(segment))
                return false;
            if (index === 0 && this.looksLikeAuthors(segment))
                return false;
            return !/^\(?\s*(?:19|20)\d{2}[a-z]?\s*\)?$/i.test(segment);
        });
        if (candidate)
            return candidate;
        const afterYear = yearIndex == null ? citation : citation.slice(yearIndex).replace(YEAR, "");
        const commaSegments = afterYear.split(/,\s+/).map(this.clean).filter(Boolean);
        return commaSegments.find(segment => segment.split(/\s+/).length >= 4);
    }
    extractCommaDelimitedTitle(citation) {
        const parts = citation.split(/\s*,\s*/).map(value => value.trim()).filter(Boolean);
        let authorEnd = 0;
        while (authorEnd < parts.length && this.looksLikeInitialsAuthorSegment(parts[authorEnd]))
            authorEnd++;
        if (!authorEnd)
            return undefined;
        const venueIndex = parts.findIndex((value, index) => index > authorEnd && /\.\s*[A-Za-z]?\d+\s*(?:\(|$)/.test(value));
        if (venueIndex <= authorEnd)
            return undefined;
        const candidate = this.clean(parts.slice(authorEnd, venueIndex).join(", "));
        return candidate.split(/\s+/).length >= 3 ? candidate : undefined;
    }
    looksLikeInitialsAuthorSegment(value) {
        return value.replace(/^and\s+/i, "").split(/\s+(?:and|&)\s+/i).every(author => /^(?:[A-ZÀ-ÖØ-Þ]\.(?:-[A-ZÀ-ÖØ-Þ]\.)?\s*){1,5}(?:(?:de|del|den|der|di|du|la|le|van|von)\s+){0,3}[A-ZÀ-ÖØ-Þ][\p{L}'’-]+$/iu.test(author.trim()));
    }
    extractJournalMetadata(raw, yearMatch) {
        if (!yearMatch || yearMatch.index == null)
            return undefined;
        const citation = raw.replace(CITATION_MARKER, "");
        const adjustedYearIndex = Math.max(0, yearMatch.index - (raw.length - citation.length));
        const authorArea = citation.slice(0, adjustedYearIndex).replace(/[,(\s.]+$/g, "");
        const afterYear = citation.slice(adjustedYearIndex).match(/^(?:19\d{2}|20\d{2})[a-z]?\)?\s*,\s*([^,]{2,100}),\s*(?:vol\.?\s*)?([A-Za-z]?\d+[A-Za-z]?)(?:\s*\((\d+)\))?\s*,\s*(?:pp?\.?\s*)?([A-Za-z]?\d+(?:[-–—][A-Za-z]?\d+)?)\b/i);
        if (afterYear && (this.looksLikeAuthors(authorArea) || /\b(?:Collaboration|Partnership)\b/i.test(authorArea) || /^[—–-]/.test(authorArea))) {
            const locator = (0, normalize_1.normalizeLocator)(afterYear[4]);
            return {
                containerTitle: this.clean(afterYear[1]),
                volume: (0, normalize_1.normalizeVolume)(afterYear[2]),
                issue: afterYear[3],
                pages: afterYear[4],
                articleNumber: locator && /^[a-z]/i.test(locator) ? locator.toUpperCase() : undefined,
                titleless: true
            };
        }
        const beforeYear = citation.slice(0, adjustedYearIndex);
        const yearLast = beforeYear.match(/,\s*([^,]{2,80}?)\s*,?\s+([A-Za-z]?\d+[A-Za-z]?)\s*,\s*([A-Za-z]?\d+(?:[-–—][A-Za-z]?\d+)?)\s*\($/i);
        if (!yearLast)
            return undefined;
        const authors = beforeYear.slice(0, yearLast.index);
        if (!this.looksLikeInitialsAuthorList(authors))
            return undefined;
        const locator = (0, normalize_1.normalizeLocator)(yearLast[3]);
        return {
            containerTitle: this.clean(yearLast[1]),
            volume: (0, normalize_1.normalizeVolume)(yearLast[2]),
            pages: yearLast[3],
            articleNumber: locator && /^[a-z]/i.test(locator) ? locator.toUpperCase() : undefined,
            titleless: true
        };
    }
    looksLikeInitialsAuthorList(value) {
        const authors = value.replace(/,?\s+(?:and|&)\s+/gi, ", ").split(/\s*,\s*/).filter(Boolean);
        return authors.length > 0 && authors.every(author => /^(?:[A-ZÀ-ÖØ-Þ](?:-[A-ZÀ-ÖØ-Þ])?\.\s*){1,5}(?:(?:de|del|den|der|di|du|la|le|van|von)\s+){0,3}[A-ZÀ-ÖØ-Þ][\p{L}'’-]+$/iu.test(author));
    }
    extractAfterAuthors(citation) {
        for (const boundary of citation.matchAll(/\.\s+(?=[A-ZÀ-ÖØ-Þ\d])/gu)) {
            const prefix = citation.slice(0, boundary.index);
            const remainder = citation.slice(boundary.index + boundary[0].length);
            if (/\b[A-ZÀ-ÖØ-Þ]\s*$/u.test(prefix)
                && /^[A-ZÀ-ÖØ-Þ][\p{L}'’-]+(?:\s*,|\s+(?:and|&)\b)/u.test(remainder))
                continue;
            if (!this.looksLikeAuthors(prefix))
                continue;
            const segments = remainder.split(/\.\s+(?=[A-ZÀ-ÖØ-Þ\d]|arXiv\b|doi\b|https?:)/u);
            let title = segments[0] || "";
            if (/:\s*[IVXLCDM]+$/i.test(title) && segments[1])
                title += `. ${segments[1]}`;
            const candidate = this.clean(title);
            const words = candidate.split(/\s+/).filter(Boolean).length;
            if (words < 2 || words > 40 || (words === 2 && (0, normalize_1.normalizeTitle)(candidate).length < 12) || this.looksLikeAuthors(candidate))
                continue;
            if (/^(?:[A-ZÀ-ÖØ-Þ]\.\s*|\(?\s*(?:19|20)\d{2})/u.test(candidate))
                continue;
            if (/\b(?:and|&)\s+[A-ZÀ-ÖØ-Þ]\.?$/u.test(candidate))
                continue;
            return candidate;
        }
        return undefined;
    }
    extractContainerTitle(raw, title) {
        const titleIndex = title ? raw.toLowerCase().indexOf(title.toLowerCase()) : -1;
        const searchFrom = titleIndex >= 0 && title ? titleIndex + title.length : 0;
        const remainder = raw.slice(searchFrom);
        const match = remainder.match(/(?:^|[,.;][”"]?)\s*[Ii]n\s*:?[\s]+(.{3,180}?)(?=,\s*(?:pp?\.?|vol\.?|no\.?|(?:19|20)\d{2})|\.\s*(?:doi|https?)|$)/);
        if (!match?.[1])
            return undefined;
        const value = this.clean(match[1]
            .replace(/^(?:[^,]{1,80}\b(?:ed|eds|editor|editors)\.?\s*,\s*)/i, "")
            .replace(/\s*\((?:pp?\.?|pages?)\s*[^)]+\)\s*$/i, ""));
        return value.split(/,\s*(?=[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)*\s*$)/u)[0] || undefined;
    }
    itemTypeHint(raw, title, containerTitle) {
        if (containerTitle) {
            if (CONFERENCE_WORD.test(containerTitle) || CONFERENCE_WORD.test(raw)
                || CONFERENCE_ACRONYM_AFTER_IN.test(raw) || CONFERENCE_ACRONYM_WITH_YEAR.test(containerTitle)) {
                return "conferencePaper";
            }
            if (BOOK_SECTION_CONTEXT.test(raw))
                return "bookSection";
        }
        if (!containerTitle && /\b(?:edition|publisher|press|isbn)\b/i.test(raw))
            return "book";
        if (title && /\b(?:vol\.?|issue|journal)\b/i.test(raw))
            return "journalArticle";
        return undefined;
    }
    looksLikeAuthors(value) {
        return /\bet\s+al\b/i.test(value)
            || /(?:^|,\s*)[A-ZÀ-ÖØ-Þ][\p{L}'’-]+,?\s+[A-Z](?:\.|\b)/u.test(value)
            || /^(?:[A-Z]\.\s*){1,3}[\p{L}'’-]+(?:\s+(?:and|&)\s+(?:[A-Z]\.\s*){1,3}[\p{L}'’-]+)?$/u.test(value)
            || FULL_NAME_LIST.test(value)
            || (value.match(/,/g)?.length || 0) >= 2;
    }
    clean(value) {
        return value.replace(/^[:;,.\s]+|[.;,\s]+$/g, "").trim();
    }
}
exports.CitationParser = CitationParser;

};
modules["src/core/normalize.ts"]=function(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeDOI = normalizeDOI;
exports.normalizeArxiv = normalizeArxiv;
exports.normalizeTitle = normalizeTitle;
exports.normalizeContainerTitle = normalizeContainerTitle;
exports.normalizeVolume = normalizeVolume;
exports.normalizeLocator = normalizeLocator;
exports.surname = surname;
exports.titleSimilarity = titleSimilarity;
exports.similarity = similarity;
function normalizeDOI(value) {
    const match = value.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
    return match?.[0].replace(/[.,;:)\]}]+$/g, "").toLowerCase();
}
function normalizeArxiv(value) {
    const match = value.match(/(?:arxiv\s*:\s*)?((?:[a-z-]+\/\d{7})|(?:\d{4}\.\d{4,5}))(?:v\d+)?/i);
    return match?.[1]?.toLowerCase();
}
function normalizeTitle(value) {
    return value
        .normalize("NFKD")
        .toLowerCase()
        .replace(/\p{M}/gu, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ");
}
const CONTAINER_ALIASES = {
    "a a": "astronomy astrophysics",
    "astronomy astrophysics": "astronomy astrophysics",
    "apj": "astrophysical journal",
    "astrophysical journal": "astrophysical journal",
    "apjs": "astrophysical journal supplement series",
    "astrophysical journal supplement series": "astrophysical journal supplement series",
    "araa": "annual review astronomy astrophysics",
    "annual review astronomy astrophysics": "annual review astronomy astrophysics",
    "mnras": "monthly notices royal astronomical society",
    "monthly notices royal astronomical society": "monthly notices royal astronomical society",
    "ann phys": "annalen physik",
    "annalen physik": "annalen physik",
    "annalen der physik": "annalen physik",
    "j med": "journal medicine",
    "journal medicine": "journal medicine"
};
function normalizeContainerTitle(value) {
    const normalized = normalizeTitle(value)
        .replace(/\bthe\b/g, " ")
        .replace(/\band\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return CONTAINER_ALIASES[normalized] || normalized;
}
function normalizeVolume(value) {
    const match = value?.trim().match(/[A-Za-z]?\d+[A-Za-z]?/);
    return match?.[0].toLowerCase();
}
function normalizeLocator(value) {
    const first = value?.trim().split(/[-–—]/)[0]?.match(/[A-Za-z]?\d+/)?.[0];
    return first?.toLowerCase();
}
function surname(value) {
    if (!value)
        return undefined;
    return normalizeTitle(value).split(" ").filter(Boolean).at(-1);
}
function titleTokens(value) {
    return normalizeTitle(value).split(" ")
        .filter(word => word.length > 2)
        .map(word => word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
}
function properTokenSubset(a, b) {
    if (a.size === b.size)
        return false;
    const [small, large] = a.size < b.size ? [a, b] : [b, a];
    return [...small].every(word => large.has(word));
}
function bigramCoverage(a, b) {
    const pairs = (words) => new Set(words.slice(0, -1).map((word, index) => `${word}\u0000${words[index + 1]}`));
    const aa = pairs(a);
    const bb = pairs(b);
    if (!aa.size || !bb.size)
        return 0;
    let intersection = 0;
    for (const pair of aa)
        if (bb.has(pair))
            intersection++;
    return intersection / Math.max(aa.size, bb.size);
}
function titleSimilarity(a, b, relaxed = false) {
    if (!a || !b)
        return undefined;
    const aWords = titleTokens(a);
    const bWords = titleTokens(b);
    const aa = new Set(aWords);
    const bb = new Set(bWords);
    if (aa.size < 4 || bb.size < 4 || properTokenSubset(aa, bb))
        return undefined;
    let intersection = 0;
    for (const word of aa)
        if (bb.has(word))
            intersection++;
    if (intersection === aa.size && intersection === bb.size && normalizeTitle(a) !== normalizeTitle(b))
        return undefined;
    if (relaxed && (aa.size - intersection > 1 || bb.size - intersection > 1))
        return undefined;
    const leftCoverage = intersection / aa.size;
    const rightCoverage = intersection / bb.size;
    const jaccard = intersection / (aa.size + bb.size - intersection);
    const order = bigramCoverage(aWords, bWords);
    const minimum = relaxed
        ? { coverage: 0.8, jaccard: 0.65, order: 0.45 }
        : { coverage: 0.85, jaccard: 0.75, order: 0.55 };
    if (leftCoverage < minimum.coverage || rightCoverage < minimum.coverage
        || jaccard < minimum.jaccard || order < minimum.order)
        return undefined;
    return 0.3 * leftCoverage + 0.3 * rightCoverage + 0.25 * jaccard + 0.15 * order;
}
function similarity(a, b) {
    if (normalizeTitle(a) === normalizeTitle(b))
        return 1;
    return titleSimilarity(a, b) || 0;
}

};
modules["src/core/types.ts"]=function(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

};
modules["src/core/LibraryMatcher.ts"]=function(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LibraryMatcher = void 0;
const normalize_1 = require("./normalize");
class LibraryMatcher {
    zotero;
    byDOI = new Map();
    byArxiv = new Map();
    byTitle = new Map();
    byCompactTitle = new Map();
    byToken = new Map();
    byAuthorYear = new Map();
    byFilenameToken = new Map();
    constructor(zotero) {
        this.zotero = zotero;
    }
    async index(libraryID) {
        await this.indexMany([libraryID]);
    }
    async indexMany(libraryIDs) {
        const items = [];
        for (const libraryID of libraryIDs) {
            try {
                items.push(...await this.zotero.Items.getAll(libraryID, true, false));
            }
            catch (error) {
                this.zotero.debug(`Reference Linker: cannot index library ${libraryID}: ${String(error)}`);
            }
        }
        this.byDOI.clear();
        this.byArxiv.clear();
        this.byTitle.clear();
        this.byCompactTitle.clear();
        this.byToken.clear();
        this.byAuthorYear.clear();
        this.byFilenameToken.clear();
        for (const item of items) {
            if (!item.isRegularItem())
                continue;
            const title = this.field(item, "title");
            if (!title)
                continue;
            const extra = this.field(item, "extra");
            const creators = item.getCreators();
            const containerTitle = this.field(item, "bookTitle")
                || this.field(item, "proceedingsTitle")
                || this.field(item, "publicationTitle")
                || undefined;
            const pdfAttachments = item.getAttachments().map(id => this.zotero.Items.get(id))
                .filter((attachment) => attachment !== false)
                .filter(attachment => attachment.attachmentContentType === "application/pdf");
            const pdfAttachmentID = pdfAttachments[0]?.id;
            const normalizedPDFNames = [...new Set(pdfAttachments
                    .map(attachment => this.normalizeFilename(attachment.attachmentFilename || ""))
                    .filter(name => name.length >= 12))];
            const record = {
                item,
                title,
                normalizedTitle: (0, normalize_1.normalizeTitle)(title),
                containerTitle,
                normalizedContainerTitle: containerTitle ? (0, normalize_1.normalizeContainerTitle)(containerTitle) : undefined,
                doi: (0, normalize_1.normalizeDOI)(this.field(item, "DOI") || extra),
                arxiv: (0, normalize_1.normalizeArxiv)(`${extra} ${this.field(item, "url")}`),
                year: this.year(this.field(item, "date")),
                firstAuthor: (0, normalize_1.surname)(creators[0]?.lastName || creators[0]?.name),
                volume: (0, normalize_1.normalizeVolume)(this.field(item, "volume")),
                issue: this.field(item, "issue") || undefined,
                pages: this.field(item, "pages") || undefined,
                articleNumber: this.field(item, "articleNumber") || undefined,
                itemType: this.itemType(item),
                pdfAttachmentID,
                normalizedPDFNames
            };
            for (const filename of normalizedPDFNames) {
                for (const token of new Set(this.tokens(filename))) {
                    const records = this.byFilenameToken.get(token) || new Set();
                    records.add(record);
                    this.byFilenameToken.set(token, records);
                }
            }
            for (const token of new Set(this.tokens(record.normalizedTitle))) {
                const records = this.byToken.get(token) || new Set();
                records.add(record);
                this.byToken.set(token, records);
            }
            if (record.doi)
                this.add(this.byDOI, record.doi, record);
            if (record.arxiv)
                this.add(this.byArxiv, record.arxiv, record);
            this.add(this.byTitle, record.normalizedTitle, record);
            this.add(this.byCompactTitle, this.compact(record.normalizedTitle), record);
            if (record.firstAuthor && record.year)
                this.add(this.byAuthorYear, this.authorYearKey(record.firstAuthor, record.year), record);
        }
    }
    match(citation) {
        return this.matchWithOutcome(citation).match;
    }
    matchWithOutcome(citation) {
        if (citation.doi) {
            const record = this.preferredIdentifierRecord(this.byDOI.get(citation.doi) || [], citation);
            if (record)
                return { match: { record, method: "doi", score: 1 }, ambiguous: false };
        }
        if (citation.arxiv) {
            const record = this.preferredIdentifierRecord(this.byArxiv.get(citation.arxiv) || [], citation);
            if (record)
                return { match: { record, method: "arxiv", score: 1 }, ambiguous: false };
        }
        const fileMatch = this.matchAttachmentFilename(citation);
        if (fileMatch)
            return fileMatch;
        const bibliographic = this.matchBibliographic(citation);
        if (bibliographic)
            return bibliographic;
        const embedded = this.matchEmbeddedLibraryTitle(citation);
        if (embedded)
            return embedded;
        if (!citation.normalizedTitle || citation.normalizedTitle.length < 12)
            return { ambiguous: false };
        const exact = (this.byTitle.get(citation.normalizedTitle) || [])
            .map(record => this.scoreCandidate(record, citation, true))
            .filter((candidate) => Boolean(candidate));
        if (exact.length)
            return this.resolve(exact, "title-exact");
        const compactExact = (this.byCompactTitle.get(this.compact(citation.normalizedTitle)) || [])
            .filter(record => record.normalizedTitle !== citation.normalizedTitle)
            .map(record => this.scoreCandidate(record, citation, true))
            .filter((candidate) => Boolean(candidate));
        if (compactExact.length)
            return this.resolve(compactExact, "title-exact");
        const records = new Set();
        for (const token of this.tokens(citation.normalizedTitle)) {
            for (const record of this.byToken.get(token) || [])
                records.add(record);
        }
        const fuzzy = [...records]
            .filter(record => record.normalizedTitle !== citation.normalizedTitle)
            .map(record => this.scoreCandidate(record, citation, false))
            .filter((candidate) => Boolean(candidate));
        return this.resolve(fuzzy, "title-fuzzy") || { ambiguous: false };
    }
    normalizeFilename(filename) {
        const base = filename.replace(/\.pdf$/i, "")
            .replace(/[_]+/g, " ")
            .replace(/(?:\s*\(\d+\)|\s*\[\d+\]|\s*\-\s*copy)\s*$/i, "");
        return (0, normalize_1.normalizeTitle)(base);
    }
    matchAttachmentFilename(citation) {
        const raw = (0, normalize_1.normalizeTitle)(citation.raw.replace(/^\s*(?:\[\s*\d+\s*\]|\d+[.)])\s*/, ""));
        const title = citation.normalizedTitle || "";
        if (!raw || raw.length < 20)
            return undefined;
        const candidateRecords = new Set();
        const queryTokens = new Set(this.tokens(title || raw).filter(token => token.length >= 5));
        if (queryTokens.size < 2)
            for (const token of this.tokens(raw))
                if (token.length >= 5)
                    queryTokens.add(token);
        for (const token of queryTokens) {
            for (const record of this.byFilenameToken.get(token) || [])
                candidateRecords.add(record);
        }
        const matches = [];
        for (const record of candidateRecords) {
            for (const filename of record.normalizedPDFNames || []) {
                const words = filename.split(" ");
                if (words.length < 3 || filename.length < 16)
                    continue;
                const containsTitle = title.length >= 16 && title.split(" ").length >= 3
                    && (" " + filename + " ").includes(" " + title + " ");
                const containedInReference = (" " + raw + " ").includes(" " + filename + " ");
                const fuzzy = title.length >= 20 && (0, normalize_1.titleSimilarity)(title, filename);
                if (!containsTitle && !containedInReference && !fuzzy)
                    continue;
                const authorMatch = Boolean(citation.firstAuthor && record.firstAuthor === citation.firstAuthor);
                const yearMatch = Boolean(citation.year && record.year === citation.year);
                if (citation.firstAuthor && record.firstAuthor && !authorMatch)
                    continue;
                if (citation.year && record.year && Math.abs(citation.year - record.year) > 1)
                    continue;
                if (words.length <= 5 && !(authorMatch || yearMatch) && !containsTitle)
                    continue;
                if (fuzzy && !containsTitle && !containedInReference && !(authorMatch || yearMatch))
                    continue;
                matches.push({ record, exact: true, score: 0.96
                        + Number(authorMatch) * 0.08 + Number(yearMatch) * 0.04
                        + Number(containsTitle) * 0.03 });
                break;
            }
        }
        return this.resolve(matches, "filename");
    }
    matchEmbeddedLibraryTitle(citation) {
        const raw = (0, normalize_1.normalizeTitle)(citation.raw.replace(/^\s*(?:\[\s*\d+\s*\]|\d+[.)])\s*/, ""));
        if (!raw || raw.length < 15)
            return undefined;
        const rawWords = raw.split(" ");
        const seen = new Set();
        const candidates = [];
        const queryTokens = [...new Set(rawWords.filter(token => token.length >= 5))].sort((a, b) => b.length - a.length);
        for (const token of queryTokens) {
            for (const record of this.byToken.get(token) || []) {
                if (seen.has(record))
                    continue;
                seen.add(record);
                const title = record.normalizedTitle;
                const words = title.split(" ");
                if (title.length < 12 || words.length < 2)
                    continue;
                if (!(" " + raw + " ").includes(" " + title + " "))
                    continue;
                if (citation.firstAuthor && record.firstAuthor && citation.firstAuthor !== record.firstAuthor)
                    continue;
                if (citation.year && record.year && Math.abs(citation.year - record.year) > 1)
                    continue;
                const authorMatches = Boolean(citation.firstAuthor && record.firstAuthor === citation.firstAuthor);
                const yearMatches = Boolean(citation.year && record.year === citation.year);
                if (words.length <= 3 && !(authorMatches && yearMatches))
                    continue;
                if (words.length > 3 && !(authorMatches || yearMatches))
                    continue;
                candidates.push({ record, exact: true, score: 0.9 + Number(authorMatches) * 0.08 + Number(yearMatches) * 0.04 });
            }
        }
        return this.resolve(candidates, "title-exact");
    }
    matchBibliographic(citation) {
        if (citation.normalizedTitle || !citation.firstAuthor || !citation.year)
            return undefined;
        const candidates = this.byAuthorYear.get(this.authorYearKey(citation.firstAuthor, citation.year)) || [];
        const scored = candidates.flatMap(record => {
            let matches = 0;
            let score = 0.45;
            const citationLocator = (0, normalize_1.normalizeLocator)(citation.articleNumber || citation.pages);
            const recordLocator = (0, normalize_1.normalizeLocator)(record.articleNumber || record.pages);
            if (citation.normalizedContainerTitle && record.normalizedContainerTitle) {
                if (citation.normalizedContainerTitle !== record.normalizedContainerTitle)
                    return [];
                matches++;
                score += 0.18;
            }
            if (citation.volume && record.volume) {
                if ((0, normalize_1.normalizeVolume)(citation.volume) !== (0, normalize_1.normalizeVolume)(record.volume))
                    return [];
                matches++;
                score += 0.16;
            }
            if (citationLocator && recordLocator) {
                if (citationLocator !== recordLocator)
                    return [];
                matches++;
                score += 0.2;
            }
            const strongEnough = matches >= 2 && Boolean(citationLocator || (citation.normalizedContainerTitle && citation.volume));
            return strongEnough ? [{ record, exact: true, score }] : [];
        });
        return this.resolve(scored, "bibliographic");
    }
    scoreCandidate(record, citation, exact) {
        const metadata = this.checkMetadata(record, citation);
        if (!metadata)
            return undefined;
        let titleScore = 1;
        if (!exact) {
            titleScore = (0, normalize_1.titleSimilarity)(citation.normalizedTitle, record.normalizedTitle) || 0;
            if (!titleScore && metadata.authorMatch && metadata.yearMatch) {
                titleScore = (0, normalize_1.titleSimilarity)(citation.normalizedTitle, record.normalizedTitle, true) || 0;
            }
            if (!titleScore)
                return undefined;
            if (!metadata.authorMatch && !metadata.yearMatch && !metadata.containerMatch && !metadata.itemTypeMatch)
                return undefined;
        }
        return {
            record,
            exact,
            score: titleScore
                + Number(metadata.authorMatch) * 0.08
                + Number(metadata.yearMatch) * 0.04
                + Number(metadata.containerMatch) * 0.05
                + Number(metadata.itemTypeMatch) * 0.03
        };
    }
    checkMetadata(record, citation) {
        const authorMatch = Boolean(citation.firstAuthor && record.firstAuthor && citation.firstAuthor === record.firstAuthor);
        if (citation.firstAuthor && record.firstAuthor && !authorMatch)
            return undefined;
        const yearMatch = Boolean(citation.year && record.year && citation.year === record.year);
        if (citation.year && record.year && Math.abs(citation.year - record.year) > 1)
            return undefined;
        const itemTypeMatch = Boolean(citation.itemTypeHint && record.itemType && citation.itemTypeHint === record.itemType);
        let containerMatch = false;
        if (citation.normalizedContainerTitle && record.normalizedContainerTitle) {
            containerMatch = citation.normalizedContainerTitle === record.normalizedContainerTitle
                || (0, normalize_1.titleSimilarity)(citation.normalizedContainerTitle, record.normalizedContainerTitle) != null;
            if (citation.itemTypeHint === "bookSection" && record.itemType === "bookSection" && !containerMatch)
                return undefined;
        }
        return { authorMatch, yearMatch, containerMatch, itemTypeMatch };
    }
    resolve(candidates, method) {
        candidates.sort((a, b) => b.score - a.score || a.record.item.id - b.record.item.id);
        let first = candidates[0];
        if (!first)
            return undefined;
        const second = candidates[1];
        if (second && first.score - second.score < 0.06) {
            const tied = candidates.filter(candidate => first.score - candidate.score < 0.06);
            const sameDOI = first.record.doi && tied.every(candidate => candidate.record.doi === first.record.doi);
            const sameArxiv = first.record.arxiv && tied.every(candidate => candidate.record.arxiv === first.record.arxiv);
            if (!sameDOI && !sameArxiv)
                return { ambiguous: true };
            first = tied.sort((a, b) => Number(Boolean(b.record.pdfAttachmentID)) - Number(Boolean(a.record.pdfAttachmentID))
                || a.record.item.id - b.record.item.id)[0];
        }
        return { match: { record: first.record, method, score: Math.min(first.score, 0.99) }, ambiguous: false };
    }
    preferredIdentifierRecord(records, citation) {
        return [...records].sort((a, b) => {
            const pdf = Number(Boolean(b.pdfAttachmentID)) - Number(Boolean(a.pdfAttachmentID));
            if (pdf)
                return pdf;
            const metadata = this.identifierMetadataScore(b, citation) - this.identifierMetadataScore(a, citation);
            return metadata || a.item.id - b.item.id;
        })[0];
    }
    identifierMetadataScore(record, citation) {
        return Number(Boolean(citation.firstAuthor && record.firstAuthor === citation.firstAuthor))
            + Number(Boolean(citation.year && record.year === citation.year));
    }
    itemType(item) {
        try {
            return this.zotero.ItemTypes?.getName(item.itemTypeID) || (this.field(item, "bookTitle") ? "bookSection" : undefined);
        }
        catch {
            return this.field(item, "bookTitle") ? "bookSection" : undefined;
        }
    }
    field(item, name) {
        try {
            return item.getField(name) || "";
        }
        catch {
            return "";
        }
    }
    tokens(value) {
        return value.split(" ").filter(word => word.length > 2);
    }
    compact(value) {
        return value.replace(/\s+/g, "");
    }
    add(map, key, record) {
        const records = map.get(key) || [];
        records.push(record);
        map.set(key, records);
    }
    authorYearKey(author, year) {
        return `${author}\u0000${year}`;
    }
    year(value) {
        const match = value.match(/\b(19\d{2}|20\d{2})\b/);
        return match ? Number(match[1]) : undefined;
    }
}
exports.LibraryMatcher = LibraryMatcher;

};
modules["src/core/PdfSectionExtractor.ts"]=function(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PdfSectionExtractor = void 0;
const normalize_1 = require("./normalize");
const REFERENCE_HEADING = /^\s*(?:\d{1,4}\s+)?(references|bibliography|works cited|literature cited|references cited)(?:\s+\d{1,4})?\s*$/i;
const STOP_HEADING = /^\s*(?:\d{1,4}\s+)?(appendix|appendices|supplementary material|supplemental material|acknowledg(?:e)?ments?)(?:\s+\d{1,4})?\b/i;
const ACKNOWLEDGEMENT_HEADING = /^\s*(?:\d{1,4}\s+)?acknowledg(?:e)?ments?(?:\s+\d{1,4})?\s*$/i;
const LETTERED_STOP_HEADING = /^\s*A(?:\.\d+)?(?:\.\s*|\s+)(?=[\p{Lu}])[^,.;]{2,100}\s*$/u;
const LABELED_START = /(?:^|\n)\s*(?:\[\s*((?=[^\]\n]{0,24}\d)[A-Za-z0-9][A-Za-z0-9+.:/_\-\s]{0,23})\s*\]|((?!(?:18|19|20|21)\d{2}\b)\d{1,4})[.)]|((?!(?:18|19|20|21)\d{2}\b)\d{1,4})(?=\s+(?:[A-ZÀ-ÖØ-Þ](?:\.|\s)|Technical\b)))(?:\s+|(?=\p{Lu}))/gu;
const PARTICLE = `(?:[Dd]e|[Dd]el|[Dd]en|[Dd]er|[Dd]i|[Dd]u|[Ll]a|[Ll]e|[Vv]an|[Vv]on)\\s+`;
const SURNAME = `(?:${PARTICLE}){0,3}[A-ZÀ-ÖØ-Þ][\\p{L}'’-]+(?:\\s+[A-ZÀ-ÖØ-Þ][\\p{L}'’-]+){0,2}`;
const INITIALS = `(?:[A-Z](?:\\.-[A-Z])?\\.(?:\\s*[A-Z](?:\\.-[A-Z])?\\.){0,5}|[A-Z](?:-[A-Z])?(?=\\s*[,;]))`;
const INITIALS_FIRST = `(?:[A-Z](?:-[A-Z])?\\.\\s*){1,5}`;
const AUTHOR_START = new RegExp(`(?:^|\\n)(?=\\s*(?:${SURNAME},\\s*${INITIALS}|${SURNAME}\\s+[A-Z](?:-[A-Z])?(?=\\s*[,;])|${INITIALS_FIRST}${SURNAME}(?=\\s*[,;])))`, "gu");
const FULLNAME_YEAR_START = /(?:^|\n)(?=[ \t]*[A-ZÀ-ÖØ-Þ][\p{L}'’.-]+(?:[ \t]+|,))/gu;
const AUTHOR_YEAR_BOUNDARY = /\.\s+((?:18|19|20|21)\d{2}[a-z]?)\s*[.]/iu;
const NON_AUTHOR_WORDS = /\b(?:in|proceedings|journal|transactions|conference|symposium|university|springer|lecture|notes|volume|pages|algorithm|efficient|fully|construction|cryptography)\b/iu;
const NAME_PART = /^(?:[A-ZÀ-ÖØ-Þ][\p{L}'’.-]+|[A-ZÀ-ÖØ-Þ]\.)$/u;
const ORGANIZATION_START = /(?:^|\n)(?=\s*[A-Z][^\n,]{1,80}\b(?:Collaboration|Partnership)\b[^\n]*\b(?:19|20)\d{2}[a-z]?\b)/gu;
const DITTO_START = /(?:^|\n)(?=\s*[—–-]\.\s*(?:19|20)\d{2}[a-z]?\b)/gu;
const DISCRETIONARY_HYPHEN = /[-\u00ad\u0002]\s*$/;
const CONTINUATION_LINE = "\u0001";
const PDF_DIACRITIC_ARTIFACT = /[´`^¨]\s*/g;
const SPLIT_HEADING_WORDS = [
    "references", "bibliography", "appendix", "appendices",
    "supplementary", "supplemental", "material", "acknowledgement",
    "acknowledgements", "acknowledgment", "acknowledgments"
].map(word => ({ word, pattern: new RegExp(`\\b${word.split("").join("\\s*")}\\b`, "gi") }));
class PdfSectionExtractor {
    async extract(pdf) {
        const structured = await this.fromOutline(pdf);
        if (structured) {
            const section = await this.extractRange(pdf, structured.startPage, structured.endPage, "zotero-structure", undefined, undefined, structured.startHeading, structured.endHeading);
            section.startHeading = structured.startHeading;
            section.endHeading = structured.endHeading;
            return section;
        }
        const scanned = await this.findByHeadings(pdf);
        if (!scanned) {
            const headingless = await this.findByNumberedReferences(pdf);
            if (!headingless)
                return undefined;
            return this.extractRange(pdf, headingless.startPage, pdf.numPages - 1, "heading-scan", headingless.startLine);
        }
        const section = await this.extractRange(pdf, scanned.startPage, scanned.endPage, "heading-scan", scanned.startLine, scanned.endLine);
        section.startHeading = "References";
        return section;
    }
    async fromOutline(pdf) {
        if (!pdf.getOutline2)
            return undefined;
        try {
            const outline = await pdf.getOutline2();
            const flat = this.flatten(outline || []);
            const refIndex = flat.findIndex(entry => REFERENCE_HEADING.test(entry.title));
            if (refIndex < 0)
                return undefined;
            const ref = flat[refIndex];
            const next = flat.slice(refIndex + 1).find(entry => entry.depth <= ref.depth && entry.page > ref.page);
            return { startPage: ref.page, endPage: next ? next.page : pdf.numPages - 1, startHeading: ref.title, endHeading: next?.title };
        }
        catch {
            return undefined;
        }
    }
    flatten(items, depth = 0) {
        const result = [];
        for (const item of items) {
            const page = item.location?.position?.pageIndex;
            if (item.title && page != null)
                result.push({ title: item.title.trim(), page, depth });
            result.push(...this.flatten(item.items || [], depth + 1));
        }
        return result;
    }
    async findByHeadings(pdf) {
        let found;
        for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
            const lines = await this.pageLines(pdf, pageIndex);
            if (!found) {
                const startLine = lines.findIndex(line => REFERENCE_HEADING.test(this.visibleLine(line)));
                if (startLine >= 0)
                    found = { startPage: pageIndex, startLine: startLine + 1 };
                continue;
            }
            const stopLine = lines.findIndex(line => this.isStopHeading(line));
            if (stopLine >= 0)
                return { ...found, endPage: pageIndex, endLine: stopLine };
        }
        return found ? { ...found, endPage: pdf.numPages - 1 } : undefined;
    }
    async findByNumberedReferences(pdf) {
        for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
            const lines = await this.pageLines(pdf, pageIndex);
            for (let startLine = 0; startLine < lines.length; startLine++) {
                if (!/^\s*1(?=\s+(?:[A-ZÀ-ÖØ-Þ](?:\.|\s)|Technical\b))/u.test(this.visibleLine(lines[startLine])))
                    continue;
                const samplePages = [lines.slice(startLine).join("\n")];
                for (let nextPage = pageIndex + 1; nextPage < Math.min(pdf.numPages, pageIndex + 3); nextPage++) {
                    samplePages.push((await this.pageLines(pdf, nextPage)).join("\n"));
                }
                const references = this.splitReferences(samplePages.join("\n"));
                if (references.length < 5)
                    continue;
                const firstFive = references.slice(0, 5);
                if (firstFive.every((reference, index) => reference.index === index + 1)
                    && firstFive.filter(reference => /\b(?:18|19|20|21)\d{2}\b/.test(reference.raw)).length >= 3) {
                    return { startPage: pageIndex, startLine };
                }
            }
        }
        return undefined;
    }
    async extractRange(pdf, startPage, endPage, source, startLine = 0, endLine, startHeading, endHeading) {
        const pages = [];
        let detectedEndPage = endPage;
        for (let pageIndex = startPage; pageIndex <= endPage; pageIndex++) {
            let lines = await this.pageLines(pdf, pageIndex);
            if (pageIndex === startPage && startHeading) {
                const headingLine = lines.findIndex(line => this.sameHeading(line, startHeading));
                if (headingLine >= 0)
                    startLine = headingLine + 1;
            }
            if (pageIndex === endPage && endHeading) {
                const headingLine = lines.findIndex(line => this.sameHeading(line, endHeading));
                if (headingLine >= 0)
                    endLine = headingLine;
            }
            if (pageIndex === startPage)
                lines = lines.slice(startLine);
            if (pageIndex === endPage && endLine != null)
                lines = lines.slice(0, endLine);
            const reorderedAcknowledgement = pageIndex === startPage
                ? lines.findIndex(line => ACKNOWLEDGEMENT_HEADING.test(this.visibleLine(line)))
                : -1;
            if (reorderedAcknowledgement >= 0) {
                pages.push(lines.slice(0, reorderedAcknowledgement).join("\n"));
                continue;
            }
            const stopLine = lines.findIndex(line => this.isStopHeading(line));
            if (stopLine >= 0) {
                lines = lines.slice(0, stopLine);
                detectedEndPage = pageIndex;
                if (lines.length)
                    pages.push(lines.join("\n"));
                break;
            }
            pages.push(lines.join("\n"));
        }
        return { startPage, endPage: detectedEndPage, references: this.splitReferences(pages.join("\n")), source };
    }
    sameHeading(a, b) {
        const normalize = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
        return normalize(this.visibleLine(a)) === normalize(this.visibleLine(b));
    }
    isStopHeading(line) {
        const visible = this.visibleLine(line);
        return STOP_HEADING.test(visible) || LETTERED_STOP_HEADING.test(visible);
    }
    visibleLine(line) {
        let visible = line.replaceAll(CONTINUATION_LINE, "");
        for (const { word, pattern } of SPLIT_HEADING_WORDS) {
            visible = visible.replace(pattern, word);
        }
        return visible;
    }
    async pageLines(pdf, pageIndex) {
        const wrappedPage = await pdf.getPage(pageIndex + 1);
        const page = this.unwrap(wrappedPage);
        if (typeof page.getTextContent !== "function") {
            throw new Error(`Reference Linker: PDF page ${pageIndex + 1} does not expose getTextContent()`);
        }
        const content = await page.getTextContent();
        const lines = [];
        let line = "";
        let lineX;
        let lineY;
        let continued = "";
        let continuedX;
        let continuedY;
        const flushLine = () => {
            const value = line.trim();
            if (DISCRETIONARY_HYPHEN.test(value)) {
                if (!continued) {
                    continuedX = lineX;
                    continuedY = lineY;
                }
                continued += value.replace(DISCRETIONARY_HYPHEN, "");
            }
            else if (value) {
                lines.push({ text: `${continued}${value}`.replace(PDF_DIACRITIC_ARTIFACT, "").trim(), x: continuedX ?? lineX, y: continuedY ?? lineY, order: lines.length });
                continued = "";
                continuedX = undefined;
                continuedY = undefined;
            }
            line = "";
            lineX = undefined;
            lineY = undefined;
        };
        for (const item of content.items) {
            if (item.str) {
                const itemY = typeof item.transform?.[5] === "number" ? item.transform[5] : undefined;
                if (line && lineY != null && itemY != null && Math.abs(itemY - lineY) > 4)
                    flushLine();
                if (!line) {
                    lineX = typeof item.transform?.[4] === "number" ? item.transform[4] : undefined;
                    lineY = itemY;
                }
                line += (line && !/[-–—\s]$/.test(line) ? " " : "") + item.str;
            }
            if (item.hasEOL)
                flushLine();
        }
        if (line.trim())
            flushLine();
        else if (continued)
            lines.push({ text: continued.replace(PDF_DIACRITIC_ARTIFACT, "").trim(), x: continuedX, y: continuedY, order: lines.length });
        const positionCounts = new Map();
        for (const value of lines) {
            if (value.x == null)
                continue;
            const position = Math.round(value.x);
            positionCounts.set(position, (positionCounts.get(position) || 0) + 1);
        }
        const recurringPositions = [...positionCounts]
            .filter(([, count]) => count >= 2)
            .map(([position]) => position);
        const numberedLines = lines.map(value => Number(value.text.match(/\s(\d{1,4})$/)?.[1] || NaN));
        let sequentialRun = 0;
        let longestSequentialRun = 0;
        for (let i = 1; i < numberedLines.length; i++) {
            sequentialRun = Number.isFinite(numberedLines[i - 1]) && numberedLines[i] === numberedLines[i - 1] + 1 ? sequentialRun + 1 : 0;
            longestSequentialRun = Math.max(longestSequentialRun, sequentialRun);
        }
        if (longestSequentialRun >= 3) {
            for (const value of lines)
                value.text = value.text.replace(/\s+\d{1,4}$/, "");
        }
        const columnBases = recurringPositions
            .sort((a, b) => a - b)
            .filter(position => !recurringPositions.some(other => position > other && position - other <= 32));
        const columnLines = columnBases.map(() => []);
        for (const value of lines) {
            if (value.x == null || value.y == null || !columnBases.length)
                continue;
            let best = 0;
            for (let i = 1; i < columnBases.length; i++) {
                if (Math.abs(value.x - columnBases[i]) < Math.abs(value.x - columnBases[best]))
                    best = i;
            }
            columnLines[best].push(value.y);
        }
        const alignedColumns = columnLines.some((left, leftIndex) => columnLines.some((right, rightIndex) => {
            if (rightIndex <= leftIndex || columnBases[rightIndex] - columnBases[leftIndex] < 100)
                return false;
            let aligned = 0;
            for (const y of left) {
                if (right.some(otherY => Math.abs(y - otherY) <= 20))
                    aligned++;
            }
            return aligned >= 2;
        }));
        const hasColumns = columnBases.length >= 2 && alignedColumns;
        const ordered = hasColumns ? (() => {
            const nearestColumn = (value) => {
                if (value.x == null)
                    return 0;
                let best = 0;
                for (let i = 1; i < columnBases.length; i++) {
                    if (Math.abs(value.x - columnBases[i]) < Math.abs(value.x - columnBases[best]))
                        best = i;
                }
                return best;
            };
            const headingIndex = lines.findIndex(value => REFERENCE_HEADING.test(this.visibleLine(value.text)));
            const firstLabeledAfterHeading = headingIndex >= 0 ? lines.slice(headingIndex + 1).find(value => /^\s*(?:\[\s*[A-Za-z0-9][^\]]{0,24}\]|\d{1,4}[.)])(?:\s+|(?=\p{Lu}))/u.test(value.text)) : undefined;
            const referenceColumn = firstLabeledAfterHeading ? nearestColumn(firstLabeledAfterHeading) : 0;
            const column = (value) => REFERENCE_HEADING.test(this.visibleLine(value.text)) ? referenceColumn : nearestColumn(value);
            return [...lines].sort((a, b) => {
                const columnDifference = column(a) - column(b);
                if (columnDifference)
                    return columnDifference;
                if (a.y != null && b.y != null && Math.abs(a.y - b.y) > 0.5)
                    return b.y - a.y;
                return a.order - b.order;
            });
        })() : lines;
        return ordered.flatMap(value => {
            let line = value.text;
            if (value.x != null) {
                const indented = columnBases.some(position => value.x - position >= 5 && value.x - position <= 36);
                const labeled = /^\s*(?:\[\s*[A-Za-z0-9][^\]]{0,24}\]|\d{1,4}[.)])(?:\s+|(?=\p{Lu}))/u.test(value.text);
                if (indented && !labeled)
                    line = `${CONTINUATION_LINE}${line}`;
            }
            return this.splitInlineReferenceHeading(line);
        });
    }
    splitInlineReferenceHeading(line) {
        const visible = this.visibleLine(line);
        const match = visible.match(/^\s*((?:\d{1,4}\s+)?(?:references cited|literature cited|works cited|references|bibliography)(?:\s+\d{1,4})?)\s+(.+)$/i);
        if (!match || !this.looksLikeReferenceStart(match[2]))
            return [line];
        return [match[1], match[2]];
    }
    looksLikeReferenceStart(value) {
        return /^\s*(?:\[\s*[A-Za-z0-9]|\d{1,4}[.)]|[A-ZÀ-ÖØ-Þ][\p{L}'’-]+(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'’-]+){0,2}\s*,|[A-ZÀ-ÖØ-Þ][\p{L}'’-]+\s+[A-Z](?:-[A-Z])?\s*[,;]|[A-Z](?:-[A-Z])?\.\s*[A-ZÀ-ÖØ-Þ][\p{L}'’-]+)/u.test(value);
    }
    unwrap(value) {
        const privileged = globalThis;
        const withWrapper = value;
        return privileged.Cu?.waiveXrays?.(value) || withWrapper.wrappedJSObject || value;
    }
    splitReferences(text) {
        const starts = [...text.matchAll(LABELED_START)];
        const labeledStarts = this.plausibleLabeledStarts(starts);
        if (labeledStarts.length >= 2) {
            const final = labeledStarts.at(-1);
            const finalNumber = Number(this.label(final));
            const numberingReset = Number.isFinite(finalNumber) ? starts.find(match => {
                if (match.index <= final.index)
                    return false;
                const label = this.label(match);
                const value = /^\d+$/.test(label) ? Number(label) : undefined;
                return value != null && value <= finalNumber;
            }) : undefined;
            return labeledStarts.map((match, i) => ({
                raw: this.visibleLine(text.slice(match.index, labeledStarts[i + 1]?.index ?? numberingReset?.index ?? text.length)).trim(),
                fragments: [],
                index: /^\d+$/.test(this.label(match)) ? Number(this.label(match)) : undefined
            })).filter(block => block.raw.length >= 20);
        }
        const indices = [...new Set([
                ...[...text.matchAll(AUTHOR_START)].map(match => match.index),
                ...[...text.matchAll(FULLNAME_YEAR_START)]
                    .filter(match => this.isFullNameYearStart(text.slice(match.index + match[0].length).split("\n", 1)[0]))
                    .map(match => match.index),
                ...[...text.matchAll(ORGANIZATION_START)].map(match => match.index),
                ...[...text.matchAll(DITTO_START)].map(match => match.index)
            ])].sort((a, b) => a - b);
        let previousAuthor;
        return indices.map((start, i) => {
            const raw = this.visibleLine(text.slice(start, indices[i + 1] ?? text.length)).trim();
            const author = this.referenceFirstAuthor(raw);
            const organization = raw.match(/^([^,]{1,80}\b(?:Collaboration|Partnership)\b)/i)?.[1];
            const firstAuthorHint = /^[—–-]\./.test(raw) ? previousAuthor : (0, normalize_1.surname)(author || organization);
            if (firstAuthorHint)
                previousAuthor = firstAuthorHint;
            return { raw, fragments: [], firstAuthorHint };
        }).filter(block => block.raw.length >= 20);
    }
    isFullNameYearStart(line) {
        if (line.startsWith(CONTINUATION_LINE))
            return false;
        const boundary = line.slice(0, 220).match(AUTHOR_YEAR_BOUNDARY);
        if (!boundary || boundary.index == null)
            return false;
        const names = line.slice(0, boundary.index).trim();
        if (!names || NON_AUTHOR_WORDS.test(names))
            return false;
        const authors = names.replace(/,?\s+(?:and|&)\s+/giu, ", ").split(/,\s*/).filter(Boolean);
        if (!authors.length || authors.length > 20)
            return false;
        return authors.every(author => {
            const words = author.trim().split(/\s+/);
            return words.length >= 2 && words.length <= 7
                && words.some(word => word.length > 2)
                && words.every(word => NAME_PART.test(word));
        });
    }
    plausibleLabeledStarts(starts) {
        if (starts.length < 2)
            return [];
        const numeric = starts.map(match => /^\d+$/.test(this.label(match)) ? Number(this.label(match)) : undefined);
        if (!numeric.some(value => value != null))
            return starts;
        const accepted = [];
        let expected = 1;
        for (let i = 0; i < starts.length; i++) {
            if (numeric[i] !== expected)
                continue;
            accepted.push(starts[i]);
            expected++;
        }
        return accepted.length >= 2 ? accepted : [];
    }
    label(match) {
        return match[1] || match[2] || match[3] || "";
    }
    referenceFirstAuthor(raw) {
        const surnameFirst = raw.match(new RegExp(`^(${SURNAME})(?:,\\s*${INITIALS}|\\s+[A-Z](?:-[A-Z])?(?=\\s*[,;]))`, "u"))?.[1];
        if (surnameFirst)
            return (0, normalize_1.surname)(surnameFirst);
        const initialsFirst = raw.match(new RegExp(`^${INITIALS_FIRST}(${SURNAME})(?=\\s*[,;])`, "u"))?.[1];
        return (0, normalize_1.surname)(initialsFirst);
    }
}
exports.PdfSectionExtractor = PdfSectionExtractor;

};
modules["src/reader/ReferenceOverlay.ts"]=function(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReferenceOverlay = void 0;
exports.unmatchedReferenceActions = unmatchedReferenceActions;
exports.findIndexedReferenceMarkers = findIndexedReferenceMarkers;
function unmatchedReferenceActions(citation) {
    const actions = [];
    if (citation.doi)
        actions.push({ kind: "open", label: "Open DOI", value: `https://doi.org/${citation.doi}` });
    const searchText = citation.title || citation.raw.trim();
    if (searchText) {
        actions.push({
            kind: "open",
            label: "Search",
            value: `https://scholar.google.com/scholar?q=${encodeURIComponent(searchText)}`
        });
        actions.push({
            kind: "copy",
            label: citation.title ? "Copy title" : "Copy reference",
            value: searchText
        });
    }
    return actions;
}
function findIndexedReferenceMarkers(text) {
    return [...text.matchAll(/\[\s*(\d{1,4})\s*\]|(?:^|\s)(\d{1,4})[.)](?=\s)/g)].map(match => ({
        index: Number(match[1] || match[2]),
        start: match.index + (match[2] ? match[0].search(/\d/) : 0)
    }));
}
class ReferenceOverlay {
    doc;
    onOpen;
    onOpenURL;
    onCopyText;
    static styleID = "reference-linker-style";
    pages = [];
    hits = new WeakMap();
    unmatched = new WeakMap();
    renderedReferences = new Set();
    menu;
    clickHandler = (event) => {
        const target = event.target instanceof this.doc.defaultView.Element ? event.target : null;
        if (target?.closest(".reference-linker-menu"))
            return;
        const hit = target?.closest(".reference-linker-hit");
        const match = hit ? this.hits.get(hit) : undefined;
        if (match) {
            event.preventDefault();
            event.stopPropagation();
            this.closeMenu();
            this.onOpen(match);
            return;
        }
        const unmatched = target?.closest(".reference-linker-unmatched");
        const citation = unmatched ? this.unmatched.get(unmatched) : undefined;
        if (!unmatched || !citation || !unmatchedReferenceActions(citation).length) {
            this.closeMenu();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.showMenu(unmatched, citation);
    };
    constructor(doc, onOpen, onOpenURL = url => { doc.defaultView?.open(url, "_blank", "noopener"); }, onCopyText) {
        this.doc = doc;
        this.onOpen = onOpen;
        this.onOpenURL = onOpenURL;
        this.onCopyText = onCopyText;
        this.installStyle();
        this.doc.addEventListener("click", this.clickHandler, true);
    }
    clear() {
        this.doc.querySelectorAll(".reference-linker-hit, .reference-linker-unmatched, .reference-linker-actionable").forEach(node => {
            node.classList.remove("reference-linker-hit", "reference-linker-unmatched", "reference-linker-actionable");
        });
        this.doc.querySelectorAll(".reference-linker-badge, .reference-linker-region").forEach(node => node.remove());
        this.closeMenu();
        this.hits = new WeakMap();
        this.unmatched = new WeakMap();
        this.renderedReferences.clear();
    }
    renderedCount() {
        return this.renderedReferences.size;
    }
    linkCount() {
        return this.doc.querySelectorAll(".reference-linker-badge").length;
    }
    render(reference, match, referenceKey, citation) {
        if (this.renderedReferences.has(referenceKey))
            return false;
        const fragments = reference.fragments;
        if (!fragments.length)
            return false;
        const last = fragments[fragments.length - 1];
        const page = last.element.closest(".page");
        if (!page)
            return false;
        let lastRect;
        let painted = 0;
        for (const fragment of fragments) {
            const element = fragment.element;
            const textNode = Array.from(element.childNodes).find(node => node.nodeType === 3);
            if (!textNode || !textNode.textContent)
                continue;
            const start = Math.max(0, Math.min(fragment.startOffset ?? 0, textNode.textContent.length));
            const end = Math.max(start, Math.min(fragment.endOffset ?? textNode.textContent.length, textNode.textContent.length));
            if (start === end)
                continue;
            const range = this.doc.createRange();
            range.setStart(textNode, start);
            range.setEnd(textNode, end);
            const rects = Array.from(range.getClientRects());
            for (const rect of rects) {
                if (rect.width < 1 || rect.height < 1)
                    continue;
                const fragmentPage = element.closest(".page");
                if (!fragmentPage)
                    continue;
                const pageRect = fragmentPage.getBoundingClientRect();
                const region = this.doc.createElement("div");
                region.className = `reference-linker-region ${match ? "reference-linker-hit" : "reference-linker-unmatched"}`;
                if (!match && citation && unmatchedReferenceActions(citation).length)
                    region.classList.add("reference-linker-actionable");
                region.style.left = `${rect.left - pageRect.left}px`;
                region.style.top = `${rect.top - pageRect.top}px`;
                region.style.width = `${rect.width}px`;
                region.style.height = `${rect.height}px`;
                if (match)
                    this.hits.set(region, match);
                else if (citation)
                    this.unmatched.set(region, citation);
                fragmentPage.append(region);
                lastRect = rect;
                painted++;
            }
        }
        if (!painted)
            return false;
        this.renderedReferences.add(referenceKey);
        if (!match || !lastRect)
            return true;
        const pageRect = page.getBoundingClientRect();
        const badge = this.doc.createElement("button");
        badge.className = "reference-linker-badge";
        badge.type = "button";
        badge.textContent = match.record.pdfAttachmentID ? "↗ PDF" : "↗ Item";
        badge.title = `${match.record.title}\nMatched by ${match.method}`;
        badge.style.left = `${Math.min(lastRect.right - pageRect.left + 6, pageRect.width - 54)}px`;
        badge.style.top = `${lastRect.top - pageRect.top}px`;
        badge.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            this.onOpen(match);
        });
        page.append(badge);
        return true;
    }
    fragmentsForRange(page, start, end) {
        const fragments = [];
        for (let i = 0; i < page.offsets.length; i++) {
            const offset = page.offsets[i];
            if (offset.end <= start || offset.start >= end)
                continue;
            fragments.push({
                text: page.spans[i].textContent || "", element: page.spans[i],
                page: page.pageIndex + 1, order: i,
                startOffset: Math.max(0, start - offset.start),
                endOffset: Math.min(offset.end, end) - offset.start
            });
        }
        return fragments;
    }
    findReferenceEnd(text, start) {
        const tail = text.slice(start);
        const stop = /(?:^|\s)(?:Received\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|\d)|Manuscript\s+received\b|Publication\s+date\s*:|Authorized\s+licensed\s+use\s+limited\s+to\b|Copyright\s+©|©\s*\d{4})/ig;
        const match = stop.exec(tail);
        return match ? start + match.index + (match[0].length - match[0].trimStart().length) : text.length;
    }
    indexPages(startPage, endPage, startHeading, endHeading) {
        this.pages = [];
        const sectionText = [];
        for (const page of this.doc.querySelectorAll(".page")) {
            const pageIndex = (Number(page.dataset.pageNumber) || 1) - 1;
            if (pageIndex < startPage || pageIndex > endPage)
                continue;
            const spans = Array.from(page.querySelectorAll(".textLayer span"));
            if (!spans.length)
                continue;
            const joined = this.joinSpans(spans);
            let searchableStart = 0;
            let searchableEnd = joined.text.length;
            if (pageIndex === startPage && startHeading) {
                const headingAt = this.findHeading(joined.text, startHeading, 0);
                if (headingAt >= 0)
                    searchableStart = headingAt + startHeading.length;
            }
            if (pageIndex === endPage && endHeading) {
                const headingAt = this.findHeading(joined.text, endHeading, searchableStart);
                if (headingAt >= 0)
                    searchableEnd = headingAt;
            }
            searchableEnd = Math.min(searchableEnd, this.findReferenceEnd(joined.text, searchableStart));
            const searchableText = joined.text.slice(searchableStart, searchableEnd);
            this.pages.push({
                page,
                pageIndex,
                spans,
                text: joined.text,
                offsets: joined.offsets,
                searchableStart,
                searchableEnd,
                compact: this.compactText(searchableText)
            });
            sectionText.push(searchableText);
        }
        return sectionText.join(" ");
    }
    renderIndexed(index, match, referenceKey = `index:${index}`) {
        return this.renderIndexedReference(index, match, referenceKey);
    }
    renderIndexedUnmatched(index, citation, referenceKey = `index:${index}`) {
        return this.renderIndexedReference(index, undefined, referenceKey, citation);
    }
    renderIndexedReference(index, match, referenceKey, citation) {
        for (const page of this.pages) {
            const markers = findIndexedReferenceMarkers(page.text).filter(marker => marker.start >= page.searchableStart && marker.start < page.searchableEnd);
            const markerIndex = markers.findIndex(marker => marker.index === index);
            if (markerIndex < 0)
                continue;
            const start = markers[markerIndex].start;
            let end = Math.min(markers[markerIndex + 1]?.start ?? page.searchableEnd, page.searchableEnd);
            if (markerIndex === markers.length - 1) {
                const tail = page.text.slice(start, end);
                const lastBibliographicYear = [...tail.matchAll(/\b(?:18|19|20|21)\d{2}[a-z]?\s*[.]?(?=\s|$)/gi)];
                const extra = lastBibliographicYear.at(-1);
                if (extra && tail.length > 240 && extra.index + extra[0].length < tail.length - 70) {
                    end = start + extra.index + extra[0].length;
                }
            }
            const fragments = this.fragmentsForRange(page, start, end);
            if (fragments.length)
                return this.render({ raw: "", fragments, index }, match, referenceKey, citation);
        }
        return false;
    }
    renderText(raw, title, match, referenceKey) {
        return this.renderAuthorYearBounded(raw, match, referenceKey) || this.renderCrossPageAuthorYear(raw, match, referenceKey) || this.renderCompleteText(raw, match, referenceKey) || this.renderTitleReference(title || raw, match, referenceKey);
    }
    renderTextUnmatched(raw, title, citation, referenceKey) {
        return this.renderAuthorYearBounded(raw, undefined, referenceKey, citation)
            || this.renderCrossPageAuthorYear(raw, undefined, referenceKey, citation)
            || this.renderCompleteText(raw, undefined, referenceKey, citation)
            || this.renderTitleReference(title || raw, undefined, referenceKey, citation);
    }
    renderAuthorYearBounded(raw, match, referenceKey, citation) {
        if (/^\s*(?:\[\s*\d+\s*\]|\d+[.)]\s)/u.test(raw))
            return false;
        let clean = raw.replace(/\s+/g, " ").trim();
        const footer = /\b(?:Received\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|\d)|Manuscript\s+received|Publication\s+date\s*:|Authorized\s+licensed\s+use|Copyright\s+©)\b/iu.exec(clean);
        if (footer)
            clean = clean.slice(0, footer.index).trim();
        const target = this.compactText(clean).text;
        if (target.length < 55)
            return false;
        const prefixes = [72, 56, 40, 28].map(n => target.slice(0, n));
        const suffixes = [56, 44, 32, 22].map(n => target.slice(-n));
        for (const page of this.pages) {
            for (const prefix of prefixes) {
                if (prefix.length < 22)
                    continue;
                let from = 0;
                while (from < page.compact.text.length) {
                    const first = this.findCompactText(page.compact.text, prefix, from);
                    if (!first)
                        break;
                    from = first.start + 1;
                    for (const suffix of suffixes) {
                        if (suffix.length < 20)
                            continue;
                        const last = this.findCompactText(page.compact.text, suffix, first.end);
                        if (!last || last.end - first.start > 2500 || last.end - first.start < Math.min(target.length * 0.55, 45))
                            continue;
                        const start = page.searchableStart + page.compact.offsets[first.start];
                        const end = page.searchableStart + page.compact.offsets[last.end - 1] + 1;
                        if (end > page.searchableEnd || start >= end)
                            continue;
                        const fragments = this.fragmentsForRange(page, start, end);
                        if (fragments.length && this.render({ raw, fragments }, match, referenceKey, citation))
                            return true;
                    }
                }
            }
        }
        return false;
    }
    // Match a reference across two pages using ONLY text belonging to the
    // reference. Running heads/feet can intervene between pages, so a simple
    // range from the first match through page end is not safe.
    renderCrossPageAuthorYear(raw, match, referenceKey, citation) {
        if (/^\s*(?:\[\s*\d+\s*\]|\d+[.)]\s)/u.test(raw))
            return false;
        // Remove commonly interleaved journal footers and running heads from
        // extracted raw references before aligning text on the two PDF pages.
        // These are not bibliography text, even if the extractor includes them.
        const cleanRaw = raw
            .replace(/ACM\s+Transactions\s+on\s+Computation\s+Theory\s*,?\s*Vol\.?[\s\S]{0,150}?Publication\s+date\s*:?\s*[A-Za-z]+\s+\d{4}\.?/giu, " ")
            .replace(/\b\d{1,2}\s*:\s*\d{1,3}\s+(?:[A-Z]\.?\s*)?[A-Z][a-z]+\s+et\s+al\.?/gu, " ");
        const target = this.compactText(cleanRaw.replace(/\s+/g, " ").trim()).text;
        if (target.length < 100)
            return false;
        const anchorLength = 24;
        for (let i = 0; i + 1 < this.pages.length; i++) {
            const first = this.pages[i];
            const second = this.pages[i + 1];
            if (second.pageIndex !== first.pageIndex + 1)
                continue;
            const begin = this.findCompactText(first.compact.text, target.slice(0, 42), 0);
            if (!begin)
                continue;
            // The reference starts in the last part of the first page.
            if (first.compact.text.length - begin.start > 1900)
                continue;
            // Determine exactly how much of the source reference is present
            // before the page break. Stop on the FIRST mismatch: this avoids
            // painting the footer after the final bibliographic word.
            let prefixLength = 0;
            while (begin.start + prefixLength < first.compact.text.length
                   && prefixLength < target.length
                   && first.compact.text[begin.start + prefixLength] === target[prefixLength]) {
                prefixLength++;
            }
            if (prefixLength < 75 || prefixLength >= target.length - 35)
                continue;
            // PDF extraction can insert a running footer into the source raw
            // text. Search near the expected split instead of assuming the
            // next page begins at precisely prefixLength in raw.
            let best;
            const low = Math.max(60, prefixLength - 12);
            const high = Math.min(target.length - anchorLength, prefixLength + 240);
            for (let offset = low; offset <= high; offset++) {
                const anchor = target.slice(offset, offset + anchorLength);
                const found = this.findCompactText(second.compact.text, anchor, 0);
                if (!found || found.start > 350)
                    continue;
                let suffixLength = 0;
                while (found.start + suffixLength < second.compact.text.length
                       && offset + suffixLength < target.length
                       && second.compact.text[found.start + suffixLength] === target[offset + suffixLength]) {
                    suffixLength++;
                }
                if (suffixLength < 35)
                    continue;
                const skipped = Math.abs(offset - prefixLength);
                // Prefer a long exact match on the second page, but avoid
                // jumping far into a different paragraph.
                const score = suffixLength - skipped * 0.35 - found.start * 0.03;
                if (!best || score > best.score)
                    best = { found, suffixLength, score, offset };
            }
            if (!best || prefixLength + best.suffixLength < target.length * 0.70)
                continue;
            const firstStart = first.searchableStart + first.compact.offsets[begin.start];
            const firstEnd = first.searchableStart + first.compact.offsets[begin.start + prefixLength - 1] + 1;
            const secondStart = second.searchableStart + second.compact.offsets[best.found.start];
            const secondEnd = second.searchableStart + second.compact.offsets[best.found.start + best.suffixLength - 1] + 1;
            if (firstStart >= firstEnd || secondStart >= secondEnd ||
                firstEnd > first.searchableEnd || secondEnd > second.searchableEnd)
                continue;
            const fragments = [
                ...this.fragmentsForRange(first, firstStart, firstEnd),
                ...this.fragmentsForRange(second, secondStart, secondEnd)
            ];
            if (fragments.length && this.render({ raw, fragments }, match, referenceKey, citation))
                return true;
        }
        return false;
    }
    renderCompleteText(raw, match, referenceKey, citation) {
        const target = this.compactText(raw.replace(/^\s*\[\s*\d{1,4}\s*\]\s*/, "")).text;
        if (target.length < 30)
            return false;
        for (const { compact, searchableStart, offsets, spans, pageIndex } of this.pages) {
            let from = 0;
            while (from <= compact.text.length - target.length) {
                const found = this.findCompactText(compact.text, target, from);
                if (!found)
                    break;
                const start = searchableStart + compact.offsets[found.start];
                const end = searchableStart + compact.offsets[found.end - 1] + 1;
                const page = this.pages.find(value => value.pageIndex === pageIndex);
                const fragments = this.fragmentsForRange(page, start, end);
                if (fragments.length && this.render({ raw, fragments }, match, referenceKey, citation))
                    return true;
                from = found.start + 1;
            }
        }
        return false;
    }
    renderTitle(title, match, referenceKey = `title:${title}`) {
        return this.renderTitleReference(title, match, referenceKey);
    }
    renderTitleUnmatched(title, citation, referenceKey = `title:${title}`) {
        return this.renderTitleReference(title, undefined, referenceKey, citation);
    }
    renderTitleReference(title, match, referenceKey, citation) {
        const target = this.compactText(title).text;
        if (target.length < 12)
            return false;
        for (const { compact, searchableStart, offsets, spans, pageIndex } of this.pages) {
            let from = 0;
            while (from <= compact.text.length - target.length) {
                const found = this.findCompactText(compact.text, target, from);
                if (!found)
                    break;
                const { start: compactStart, end: compactEnd } = found;
                const start = searchableStart + compact.offsets[compactStart];
                const end = searchableStart + compact.offsets[compactEnd - 1] + 1;
                const page = this.pages.find(value => value.pageIndex === pageIndex);
                const fragments = this.fragmentsForRange(page, start, end);
                if (fragments.length && this.render({ raw: title, fragments }, match, referenceKey, citation))
                    return true;
                from = compactStart + 1;
            }
        }
        return false;
    }
    findCompactText(source, target, from) {
        const exact = source.indexOf(target, from);
        if (exact >= 0)
            return { start: exact, end: exact + target.length };
        for (let start = from; start < source.length; start++) {
            let sourceIndex = start;
            let targetIndex = 0;
            while (sourceIndex < source.length && targetIndex < target.length) {
                if (source[sourceIndex] === target[targetIndex]) {
                    sourceIndex++;
                    targetIndex++;
                    continue;
                }
                const insertedNumber = source.slice(sourceIndex).match(/^\d{1,4}/)?.[0];
                if (!insertedNumber || /\d/.test(target[targetIndex]))
                    break;
                sourceIndex += insertedNumber.length;
            }
            if (targetIndex === target.length)
                return { start, end: sourceIndex };
        }
        return undefined;
    }
    destroy() {
        this.clear();
        this.doc.removeEventListener("click", this.clickHandler, true);
        this.doc.getElementById(ReferenceOverlay.styleID)?.remove();
    }
    showMenu(anchor, citation) {
        this.closeMenu();
        const menu = this.doc.createElement("div");
        menu.className = "reference-linker-menu";
        menu.setAttribute("role", "menu");
        for (const action of unmatchedReferenceActions(citation)) {
            const button = this.doc.createElement("button");
            button.type = "button";
            button.textContent = action.label;
            button.setAttribute("role", "menuitem");
            button.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                if (action.kind === "open") {
                    this.onOpenURL(action.value);
                    this.closeMenu();
                }
                else {
                    const copying = this.onCopyText ? this.onCopyText(action.value) : this.copyText(action.value);
                    void Promise.resolve(copying).then(() => this.closeMenu(), () => this.closeMenu());
                }
            });
            menu.append(button);
        }
        (this.doc.body || this.doc.documentElement).append(menu);
        const anchorRect = anchor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const width = this.doc.documentElement.clientWidth;
        const height = this.doc.documentElement.clientHeight;
        menu.style.left = `${Math.max(8, Math.min(anchorRect.left, width - menuRect.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(anchorRect.bottom + 4, height - menuRect.height - 8))}px`;
        this.menu = menu;
    }
    closeMenu() {
        this.menu?.remove();
        this.menu = undefined;
    }
    copyText(text) {
        const clipboard = this.doc.defaultView?.navigator.clipboard;
        if (clipboard)
            return clipboard.writeText(text);
        const textarea = this.doc.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        (this.doc.body || this.doc.documentElement).append(textarea);
        textarea.select();
        this.doc.execCommand("copy");
        textarea.remove();
    }
    installStyle() {
        if (this.doc.getElementById(ReferenceOverlay.styleID))
            return;
        const style = this.doc.createElement("style");
        style.id = ReferenceOverlay.styleID;
        style.textContent = `
      .reference-linker-region { position: absolute; z-index: 9; box-sizing: border-box; border-radius: 2px; }
      .reference-linker-hit { background: rgba(255, 225, 90, .17) !important; cursor: pointer; }
      .reference-linker-unmatched { background: rgba(140, 146, 154, .14) !important; }
      .reference-linker-actionable { cursor: pointer; }
      .reference-linker-badge { position: absolute; z-index: 50; border: 1px solid rgba(90,70,0,.35); border-radius: 4px; padding: 1px 5px; background: #fff3a6; color: #342b00; font: 600 10px/16px system-ui, sans-serif; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
      .reference-linker-badge:hover { background: #ffe35c; }
      .reference-linker-menu { position: fixed; z-index: 100; display: flex; gap: 4px; padding: 5px; border: 1px solid rgba(0,0,0,.18); border-radius: 7px; background: rgba(255,255,255,.97); box-shadow: 0 3px 12px rgba(0,0,0,.22); }
      .reference-linker-menu button { border: 0; border-radius: 4px; padding: 4px 7px; background: transparent; color: #222; font: 600 11px/16px system-ui, sans-serif; white-space: nowrap; cursor: pointer; }
      .reference-linker-menu button:hover { background: rgba(0,0,0,.08); }
    `;
        (this.doc.head || this.doc.documentElement).append(style);
    }
    joinSpans(spans) {
        let text = "";
        const offsets = [];
        for (const span of spans) {
            if (text)
                text += " ";
            const start = text.length;
            text += span.textContent || "";
            offsets.push({ start, end: text.length });
        }
        return { text, offsets };
    }
    findHeading(text, heading, from) {
        const words = heading.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const match = new RegExp(words.join("\\s+"), "i").exec(text.slice(from));
        return match ? from + match.index : -1;
    }
    compactText(value) {
        let text = "";
        const offsets = [];
        for (let i = 0; i < value.length; i++) {
            const normalized = value[i].normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "");
            for (const character of normalized) {
                if (!/[\p{L}\p{N}]/u.test(character))
                    continue;
                text += character;
                offsets.push(i);
            }
        }
        return { text, offsets };
    }
}
exports.ReferenceOverlay = ReferenceOverlay;

};
const cache=Object.create(null);
function load(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,function(spec){const p=id.split('/');p.pop();for(const s of spec.split('/')){if(s==='..')p.pop();else if(s!=='.')p.push(s)}return load(p.join('/')+'.ts')});return m.exports}
globalThis.ReferenceLinker=load('src/index.ts');
})();
