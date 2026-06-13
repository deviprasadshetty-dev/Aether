/**
 * Shared in-page DOM collection helpers.
 *
 * These helpers are injected (as source text) into every element-collection
 * script so that the LocatorEngine, the Set-of-Marks overlay collector, and the
 * compact snapshot all derive selectors, roles, names, and visibility the SAME
 * way. Previously each call site had its own divergent copy, so `get_state`,
 * `list_interactive_elements`, and the semantic click resolver could disagree
 * about the same element.
 *
 * Role/name resolution follows the WAI-ARIA implicit-role mapping and the
 * accessible-name computation closely enough that role/label targeting matches
 * what the browser's own accessibility tree reports.
 */
export const SHARED_DOM_HELPERS = `
    function aetherNorm(value) {
        return String(value == null ? '' : value).trim().replace(/\\s+/g, ' ');
    }

    function aetherVisible(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0';
    }

    // WAI-ARIA implicit role mapping. Mirrors what the accessibility tree reports
    // so role-based targeting (click_role, fill_label) lines up with the browser.
    function aetherImplicitRole(el) {
        const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
        if (explicit) return explicit.split(/\\s+/)[0];
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        switch (tag) {
            case 'a':
            case 'area':
                return el.hasAttribute('href') ? 'link' : 'generic';
            case 'button':
                return 'button';
            case 'summary':
                return 'button';
            case 'select':
                return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
            case 'textarea':
                return 'textbox';
            case 'progress':
                return 'progressbar';
            case 'output':
                return 'status';
            case 'input':
                switch (type) {
                    case 'button':
                    case 'submit':
                    case 'reset':
                    case 'image':
                        return 'button';
                    case 'checkbox':
                        return 'checkbox';
                    case 'radio':
                        return 'radio';
                    case 'range':
                        return 'slider';
                    case 'number':
                        return 'spinbutton';
                    case 'search':
                        return el.getAttribute('list') ? 'combobox' : 'searchbox';
                    case 'email':
                    case 'tel':
                    case 'text':
                    case 'url':
                    case '':
                        return el.getAttribute('list') ? 'combobox' : 'textbox';
                    default:
                        return 'textbox';
                }
        }
        if (el.isContentEditable) return 'textbox';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        return tag;
    }

    function aetherTextById(doc, id) {
        if (!id) return '';
        try {
            const el = doc.getElementById(id);
            return el ? aetherNorm(el.innerText || el.textContent) : '';
        } catch (e) {
            return '';
        }
    }

    function aetherLabelFor(el) {
        const doc = el.ownerDocument;
        const labelledBy = aetherNorm(
            (el.getAttribute('aria-labelledby') || '')
                .split(/\\s+/)
                .map(function (id) { return aetherTextById(doc, id); })
                .join(' ')
        );
        if (labelledBy) return labelledBy;
        if (el.id) {
            try {
                const direct = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                if (direct) return aetherNorm(direct.innerText || direct.textContent);
            } catch (e) {}
        }
        const wrapping = el.closest && el.closest('label');
        return wrapping ? aetherNorm(wrapping.innerText || wrapping.textContent) : '';
    }

    // Accessible-name computation (simplified): aria-label > aria-labelledby/label >
    // placeholder > alt > title > control value > visible text.
    function aetherAccessibleName(el) {
        return aetherNorm(
            el.getAttribute('aria-label') ||
            aetherLabelFor(el) ||
            el.getAttribute('placeholder') ||
            el.getAttribute('alt') ||
            el.getAttribute('title') ||
            ((el.tagName === 'INPUT' || el.tagName === 'BUTTON') ? el.getAttribute('value') : '') ||
            el.innerText ||
            el.textContent ||
            el.getAttribute('name') ||
            ''
        );
    }

    function aetherIsUnique(root, selector) {
        try {
            return root.querySelectorAll(selector).length === 1;
        } catch (e) {
            return false;
        }
    }

    function aetherStructuralPath(el) {
        const path = [];
        let node = el;
        const stop = el.ownerDocument ? el.ownerDocument.body : null;
        while (node && node.nodeType === Node.ELEMENT_NODE && node !== stop) {
            let part = node.nodeName.toLowerCase();
            if (node.classList && node.classList.length) {
                part += '.' + Array.from(node.classList).slice(0, 2).map(function (c) { return CSS.escape(c); }).join('.');
            }
            const parent = node.parentElement;
            if (parent) {
                const same = Array.from(parent.children).filter(function (child) { return child.nodeName === node.nodeName; });
                if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
            }
            path.unshift(part);
            node = parent;
        }
        return path.join(' > ');
    }

    // Prefer stable, intent-revealing selectors (test ids, id, name, aria-label)
    // and only fall back to a brittle structural path when nothing stable+unique
    // is available.
    function aetherStableSelector(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
        const root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
        const tag = el.tagName.toLowerCase();

        const testAttrs = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-automation-id'];
        for (let i = 0; i < testAttrs.length; i++) {
            const v = el.getAttribute(testAttrs[i]);
            if (v) {
                const sel = '[' + testAttrs[i] + '=' + JSON.stringify(v) + ']';
                if (aetherIsUnique(root, sel)) return sel;
            }
        }

        if (el.id) {
            const sel = '#' + CSS.escape(el.id);
            if (aetherIsUnique(root, sel)) return sel;
        }

        const name = el.getAttribute('name');
        if (name && (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button')) {
            const sel = tag + '[name=' + JSON.stringify(name) + ']';
            if (aetherIsUnique(root, sel)) return sel;
        }

        const aria = el.getAttribute('aria-label');
        if (aria) {
            const sel = tag + '[aria-label=' + JSON.stringify(aria) + ']';
            if (aetherIsUnique(root, sel)) return sel;
        }

        return aetherStructuralPath(el);
    }
`;
