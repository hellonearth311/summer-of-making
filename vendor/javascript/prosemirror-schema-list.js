import { findWrapping, ReplaceAroundStep, canSplit, liftTarget, canJoin } from 'prosemirror-transform';

import { NodeRange, Fragment, Slice } from 'prosemirror-model';

import { Selection } from 'prosemirror-state';


const olDOM = ["ol", 0], ulDOM = ["ul", 0], liDOM = ["li", 0];

/**

An ordered list [node spec](https://prosemirror.net/docs/ref/#model.NodeSpec). Has a single

attribute, `order`, which determines the number at which the list

starts counting, and defaults to 1. Represented as an `<ol>`

element.

*/

const orderedList = {

    attrs: { order: { default: 1, validate: "number" } },

    parseDOM: [{ tag: "ol", getAttrs(dom) {

                return { order: dom.hasAttribute("start") ? +dom.getAttribute("start") : 1 };

            } }],

    toDOM(node) {

        return node.attrs.order == 1 ? olDOM : ["ol", { start: node.attrs.order }, 0];

    }

};

/**

A bullet list node spec, represented in the DOM as `<ul>`.

*/

const bulletList = {

    parseDOM: [{ tag: "ul" }],

    toDOM() { return ulDOM; }

};

/**

A list item (`<li>`) spec.

*/

const listItem = {

    parseDOM: [{ tag: "li" }],

    toDOM() { return liDOM; },

    defining: true

};

function add(obj, props) {

    let copy = {};

    for (let prop in obj)

        copy[prop] = obj[prop];

    for (let prop in props)

        copy[prop] = props[prop];

    return copy;

}

/**

Convenience function for adding list-related node types to a map

specifying the nodes for a schema. Adds

[`orderedList`](https://prosemirror.net/docs/ref/#schema-list.orderedList) as `"ordered_list"`,

[`bulletList`](https://prosemirror.net/docs/ref/#schema-list.bulletList) as `"bullet_list"`, and

[`listItem`](https://prosemirror.net/docs/ref/#schema-list.listItem) as `"list_item"`.


`itemContent` determines the content expression for the list items.

If you want the commands defined in this module to apply to your

list structure, it should have a shape like `"paragraph block*"` or

`"paragraph (ordered_list | bullet_list)*"`. `listGroup` can be

given to assign a group name to the list node types, for example

`"block"`.

*/

function addListNodes(nodes, itemContent, listGroup) {

    return nodes.append({

        ordered_list: add(orderedList, { content: "list_item+", group: listGroup }),

        bullet_list: add(bulletList, { content: "list_item+", group: listGroup }),

        list_item: add(listItem, { content: itemContent })

    });

}

/**

Returns a command function that wraps the selection in a list with

the given type an attributes. If `dispatch` is null, only return a

value to indicate whether this is possible, but don't actually

perform the change.

*/

function wrapInList(listType, attrs = null) {

    return function (state, dispatch) {

        let { $from, $to } = state.selection;

        let range = $from.blockRange($to);

        if (!range)

            return false;

        let tr = dispatch ? state.tr : null;

        if (!wrapRangeInList(tr, range, listType, attrs))

            return false;

        if (dispatch)

            dispatch(tr.scrollIntoView());

        return true;

    };

}

/**

Try to wrap the given node range in a list of the given type.

Return `true` when this is possible, `false` otherwise. When `tr`

is non-null, the wrapping is added to that transaction. When it is

`null`, the function only queries whether the wrapping is

possible.

*/

function wrapRangeInList(tr, range, listType, attrs = null) {

    let doJoin = false, outerRange = range, doc = range.$from.doc;

    // This is at the top of an existing list item

    if (range.depth >= 2 && range.$from.node(range.depth - 1).type.compatibleContent(listType) && range.startIndex == 0) {

        // Don't do anything if this is the top of the list

        if (range.$from.index(range.depth - 1) == 0)

            return false;

        let $insert = doc.resolve(range.start - 2);

        outerRange = new NodeRange($insert, $insert, range.depth);

        if (range.endIndex < range.parent.childCount)

            range = new NodeRange(range.$from, doc.resolve(range.$to.end(range.depth)), range.depth);

        doJoin = true;

    }

    let wrap = findWrapping(outerRange, listType, attrs, range);

    if (!wrap)

        return false;

    if (tr)

        doWrapInList(tr, range, wrap, doJoin, listType);

    return true;

}

function doWrapInList(tr, range, wrappers, joinBefore, listType) {

    let content = Fragment.empty;

    for (let i = wrappers.length - 1; i >= 0; i--)

        content = Fragment.from(wrappers[i].type.create(wrappers[i].attrs, content));

    tr.step(new ReplaceAroundStep(range.start - (joinBefore ? 2 : 0), range.end, range.start, range.end, new Slice(content, 0, 0), wrappers.length, true));

    let found = 0;

    for (let i = 0; i < wrappers.length; i++)

        if (wrappers[i].type == listType)

            found = i + 1;

    let splitDepth = wrappers.length - found;

    let splitPos = range.start + wrappers.length - (joinBefore ? 2 : 0), parent = range.parent;

    for (let i = range.startIndex, e = range.endIndex, first = true; i < e; i++, first = false) {

        if (!first && canSplit(tr.doc, splitPos, splitDepth)) {

            tr.split(splitPos, splitDepth);

            splitPos += 2 * splitDepth;

        }

        splitPos += parent.child(i).nodeSize;

    }

    return tr;

}

/**

Build a command that splits a non-empty textblock at the top level

of a list item by also splitting that list item.

*/

function splitListItem(itemType, itemAttrs) {

    return function (state, dispatch) {

        let { $from, $to, node } = state.selection;

        if ((node && node.isBlock) || $from.depth < 2 || !$from.sameParent($to))

            return false;

        let grandParent = $from.node(-1);

        if (grandParent.type != itemType)

            return false;

        if ($from.parent.content.size == 0 && $from.node(-1).childCount == $from.indexAfter(-1)) {

            // In an empty block. If this is a nested list, the wrapping

            // list item should be split. Otherwise, bail out and let next

            // command handle lifting.

            if ($from.depth == 3 || $from.node(-3).type != itemType ||

                $from.index(-2) != $from.node(-2).childCount - 1)

                return false;

            if (dispatch) {

                let wrap = Fragment.empty;

                let depthBefore = $from.index(-1) ? 1 : $from.index(-2) ? 2 : 3;

                // Build a fragment containing empty versions of the structure

                // from the outer list item to the parent node of the cursor

                for (let d = $from.depth - depthBefore; d >= $from.depth - 3; d--)

                    wrap = Fragment.from($from.node(d).copy(wrap));

                let depthAfter = $from.indexAfter(-1) < $from.node(-2).childCount ? 1

                    : $from.indexAfter(-2) < $from.node(-3).childCount ? 2 : 3;

                // Add a second list item with an empty default start node

                wrap = wrap.append(Fragment.from(itemType.createAndFill()));

                let start = $from.before($from.depth - (depthBefore - 1));

                let tr = state.tr.replace(start, $from.after(-depthAfter), new Slice(wrap, 4 - depthBefore, 0));

                let sel = -1;

                tr.doc.nodesBetween(start, tr.doc.content.size, (node, pos) => {

                    if (sel > -1)

                        return false;

                    if (node.isTextblock && node.content.size == 0)

                        sel = pos + 1;

                });

                if (sel > -1)

                    tr.setSelection(Selection.near(tr.doc.resolve(sel)));

                dispatch(tr.scrollIntoView());

            }

            return true;

        }

        let nextType = $to.pos == $from.end() ? grandParent.contentMatchAt(0).defaultType : null;

        let tr = state.tr.delete($from.pos, $to.pos);

        let types = nextType ? [itemAttrs ? { type: itemType, attrs: itemAttrs } : null, { type: nextType }] : undefined;

        if (!canSplit(tr.doc, $from.pos, 2, types))

            return false;

        if (dispatch)

            dispatch(tr.split($from.pos, 2, types).scrollIntoView());

        return true;

    };

}

/**

Acts like [`splitListItem`](https://prosemirror.net/docs/ref/#schema-list.splitListItem), but

without resetting the set of active marks at the cursor.

*/

function splitListItemKeepMarks(itemType, itemAttrs) {

    let split = splitListItem(itemType, itemAttrs);

    return (state, dispatch) => {

        return split(state, dispatch && (tr => {

            let marks = state.storedMarks || (state.selection.$to.parentOffset && state.selection.$from.marks());

            if (marks)

                tr.ensureMarks(marks);

            dispatch(tr);

        }));

    };

}

/**

Create a command to lift the list item around the selection up into

a wrapping list.

*/

function liftListItem(itemType) {

    return function (state, dispatch) {

        let { $from, $to } = state.selection;

        let range = $from.blockRange($to, node => node.childCount > 0 && node.firstChild.type == itemType);

        if (!range)

            return false;

        if (!dispatch)

            return true;

        if ($from.node(range.depth - 1).type == itemType) // Inside a parent list

            return liftToOuterList(state, dispatch, itemType, range);

        else // Outer list node

            return liftOutOfList(state, dispatch, range);

    };

}

function liftToOuterList(state, dispatch, itemType, range) {

    let tr = state.tr, end = range.end, endOfList = range.$to.end(range.depth);

    if (end < endOfList) {

        // There are siblings after the lifted items, which must become

        // children of the last item

        tr.step(new ReplaceAroundStep(end - 1, endOfList, end, endOfList, new Slice(Fragment.from(itemType.create(null, range.parent.copy())), 1, 0), 1, true));

        range = new NodeRange(tr.doc.resolve(range.$from.pos), tr.doc.resolve(endOfList), range.depth);

    }

    const target = liftTarget(range);

    if (target == null)

        return false;

    tr.lift(range, target);

    let $after = tr.doc.resolve(tr.mapping.map(end, -1) - 1);

    if (canJoin(tr.doc, $after.pos) && $after.nodeBefore.type == $after.nodeAfter.type)

        tr.join($after.pos);

    dispatch(tr.scrollIntoView());

    return true;

}

function liftOutOfList(state, dispatch, range) {

    let tr = state.tr, list = range.parent;

    // Merge the list items into a single big item

    for (let pos = range.end, i = range.endIndex - 1, e = range.startIndex; i > e; i--) {

        pos -= list.child(i).nodeSize;

        tr.delete(pos - 1, pos + 1);

    }

    let $start = tr.doc.resolve(range.start), item = $start.nodeAfter;

    if (tr.mapping.map(range.end) != range.start + $start.nodeAfter.nodeSize)

        return false;

    let atStart = range.startIndex == 0, atEnd = range.endIndex == list.childCount;

    let parent = $start.node(-1), indexBefore = $start.index(-1);

    if (!parent.canReplace(indexBefore + (atStart ? 0 : 1), indexBefore + 1, item.content.append(atEnd ? Fragment.empty : Fragment.from(list))))

        return false;

    let start = $start.pos, end = start + item.nodeSize;

    // Strip off the surrounding list. At the sides where we're not at

    // the end of the list, the existing list is closed. At sides where

    // this is the end, it is overwritten to its end.

    tr.step(new ReplaceAroundStep(start - (atStart ? 1 : 0), end + (atEnd ? 1 : 0), start + 1, end - 1, new Slice((atStart ? Fragment.empty : Fragment.from(list.copy(Fragment.empty)))

        .append(atEnd ? Fragment.empty : Fragment.from(list.copy(Fragment.empty))), atStart ? 0 : 1, atEnd ? 0 : 1), atStart ? 0 : 1));

    dispatch(tr.scrollIntoView());

    return true;

}

/**

Create a command to sink the list item around the selection down

into an inner list.

*/

function sinkListItem(itemType) {

    return function (state, dispatch) {

        let { $from, $to } = state.selection;

        let range = $from.blockRange($to, node => node.childCount > 0 && node.firstChild.type == itemType);

        if (!range)

            return false;

        let startIndex = range.startIndex;

        if (startIndex == 0)

            return false;

        let parent = range.parent, nodeBefore = parent.child(startIndex - 1);

        if (nodeBefore.type != itemType)

            return false;

        if (dispatch) {

            let nestedBefore = nodeBefore.lastChild && nodeBefore.lastChild.type == parent.type;

            let inner = Fragment.from(nestedBefore ? itemType.create() : null);

            let slice = new Slice(Fragment.from(itemType.create(null, Fragment.from(parent.type.create(null, inner)))), nestedBefore ? 3 : 1, 0);

            let before = range.start, after = range.end;

            dispatch(state.tr.step(new ReplaceAroundStep(before - (nestedBefore ? 3 : 1), after, before, after, slice, 1, true))

                .scrollIntoView());

        }

        return true;

    };

}


export { addListNodes, bulletList, liftListItem, listItem, orderedList, sinkListItem, splitListItem, splitListItemKeepMarks, wrapInList, wrapRangeInList };