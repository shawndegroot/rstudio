/*
 * image.ts
 *
 * Copyright (C) 2019-20 by RStudio, PBC
 *
 * Unless you have received this program directly from RStudio pursuant
 * to the terms of a commercial license agreement with RStudio, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */

import { Node as ProsemirrorNode, Schema, DOMOutputSpec } from 'prosemirror-model';
import { EditorState, NodeSelection, Transaction, Plugin, PluginKey } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { ProsemirrorCommand, EditorCommandId } from '../../api/command';
import { Extension } from '../../api/extension';
import { canInsertNode } from '../../api/node';
import { selectionIsImageNode, selectionIsEmptyParagraph } from '../../api/selection';
import {
  pandocAttrSpec,
  pandocAttrParseDom,
  pandocAttrToDomAttr,
  pandocAttrReadAST,
  pandocAttrAvailable,
} from '../../api/pandoc_attr';
import {
  PandocOutput,
  PandocTokenType,
  ProsemirrorWriter,
  PandocToken,
  tokensCollectText,
  PandocExtensions,
  imageAttributesAvailable,
} from '../../api/pandoc';
import { EditorUI } from '../../api/ui';
import { ImageDimensions } from '../../api/image';
import { asHTMLTag } from '../../api/html';
import { EditorOptions } from '../../api/options';
import { EditorEvents } from '../../api/events';

import { imageDialog } from './image-dialog';
import { imageDrop } from './image-events';
import { ImageNodeView } from './image-view';
import { imageDimensionsFromImg, imageContainerWidth, inlineHTMLIsImage } from './image-util';

const TARGET_URL = 0;
const TARGET_TITLE = 1;

const IMAGE_ATTR = 0;
const IMAGE_ALT = 1;
const IMAGE_TARGET = 2;

const plugin = new PluginKey('image');

const extension = (
  pandocExtensions: PandocExtensions,
  _options: EditorOptions,
  ui: EditorUI,
  events: EditorEvents,
): Extension => {
  const imageAttr = imageAttributesAvailable(pandocExtensions);

  return {
    nodes: [
      {
        name: 'image',
        spec: {
          inline: true,
          attrs: imageNodeAttrsSpec(false, imageAttr),
          group: 'inline',
          draggable: true,
          parseDOM: [
            {
              tag: 'img[src]',
              getAttrs(dom: Node | string) {
                return imageAttrsFromDOM(dom as Element, imageAttr);
              },
            },
          ],
          toDOM(node: ProsemirrorNode) {
            return imageDOMOutputSpec(node, imageAttr);
          },
        },
        pandoc: {
          readers: [
            {
              token: PandocTokenType.Image,
              handler: pandocImageHandler(false, imageAttr),
            },
          ],
          inlineHTMLReader: imageInlineHTMLReader,
          writer: imagePandocOutputWriter(false, ui),
        },
      },
    ],

    commands: (_schema: Schema) => {
      return [new ProsemirrorCommand(EditorCommandId.Image, ['Shift-Mod-i'], imageCommand(ui, imageAttr))];
    },

    plugins: (schema: Schema) => {
      return [
        new Plugin({
          key: plugin,
          props: {
            nodeViews: {
              image(node: ProsemirrorNode, view: EditorView, getPos: boolean | (() => number)) {
                return new ImageNodeView(node, view, getPos as () => number, ui, events, pandocExtensions);
              },
            },
            handleDOMEvents: {
              drop: imageDrop(),
            },
          },
        }),
      ];
    },
  };
};

export function pandocImageHandler(figure: boolean, imageAttributes: boolean) {
  return (schema: Schema) => (writer: ProsemirrorWriter, tok: PandocToken) => {
    // get attributes
    const target = tok.c[IMAGE_TARGET];
    const attrs = {
      src: target[TARGET_URL],
      title: readPandocTitle(target[TARGET_TITLE]),
      alt: '',
      ...(imageAttributes ? pandocAttrReadAST(tok, IMAGE_ATTR) : {}),
    };

    // add alt as plain text if it's not a figure
    if (!figure) {
      attrs.alt = tokensCollectText(tok.c[IMAGE_ALT]);
    }

    // read image and (if appropriate) children
    writer.openNode(figure ? schema.nodes.figure : schema.nodes.image, attrs);
    if (figure) {
      writer.writeTokens(tok.c[IMAGE_ALT]);
    }
    writer.closeNode();
  };
}

export function imagePandocOutputWriter(figure: boolean, ui: EditorUI) {
  return (output: PandocOutput, node: ProsemirrorNode) => {
    // default writer for markdown images
    let writer = () => {
      output.writeToken(PandocTokenType.Image, () => {
        if (output.extensions.link_attributes) {
          output.writeAttr(node.attrs.id, node.attrs.classes, node.attrs.keyvalue);
        } else {
          output.writeAttr();
        }
        output.writeArray(() => {
          if (figure) {
            output.writeInlines(node.content);
          } else {
            output.writeText(node.attrs.alt);
          }
        });
        output.write([node.attrs.src, node.attrs.title || '']);
      });
    };

    // see if we need to write raw html
    const writeHTML =
      pandocAttrAvailable(node.attrs) && // attribs need to be written
      !output.extensions.link_attributes && // markdown attribs not supported
      output.extensions.raw_html; // raw html is supported

    // if we do, then substitute a raw html writer
    if (writeHTML) {
      writer = () => {
        const imgAttr = imageDOMAttributes(node, true, false);
        const html = asHTMLTag('img', imgAttr, true);
        output.writeRawMarkdown(html);
      };
    }

    // write (wrap in paragraph and possibly link for  figures)
    if (figure) {
      let writeFigure = writer;
      if (node.attrs.linkTo) {
        writeFigure = () => {
          output.writeLink(node.attrs.linkTo, '', null, writer);
        };
      }
      output.writeToken(PandocTokenType.Para, writeFigure);
    } else {
      writer();
    }
  };
}

// parse inline html with <img> as image node
function imageInlineHTMLReader(schema: Schema, html: string, writer: ProsemirrorWriter) {
  if (inlineHTMLIsImage(html)) {
    const attrs = imageAttrsFromHTML(html);
    if (attrs) {
      writer.addNode(schema.nodes.image, attrs, []);
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

export function imageDOMOutputSpec(node: ProsemirrorNode, imageAttributes: boolean): DOMOutputSpec {
  return ['img', imageDOMAttributes(node, imageAttributes)];
}

export function imageDOMAttributes(
  node: ProsemirrorNode,
  imageAttributes: boolean,
  marker = true,
): { [key: string]: string } {
  const attr: { [key: string]: string } = {
    src: node.attrs.src,
  };
  const title = node.attrs.title;
  if (title) {
    attr.title = title;
  }
  const alt = node.attrs.alt || node.textContent;
  if (alt) {
    attr.alt = alt;
  }

  return {
    ...attr,
    ...(imageAttributes ? pandocAttrToDomAttr(node.attrs, marker) : {}),
  };
}

export function imageNodeAttrsSpec(linkTo: boolean, imageAttributes: boolean) {
  return {
    src: {},
    title: { default: null },
    alt: { default: null },
    ...(linkTo ? { linkTo: { default: null } } : {}),
    ...(imageAttributes ? pandocAttrSpec : {}),
  };
}

export function imageAttrsFromDOM(el: Element, imageAttributes: boolean) {
  const attrs: { [key: string]: string | null } = {
    src: el.getAttribute('src') || null,
    title: el.getAttribute('title') || null,
    alt: el.getAttribute('alt') || null,
  };
  return {
    ...attrs,
    ...(imageAttributes ? pandocAttrParseDom(el, attrs) : {}),
  };
}

export function imageAttrsFromHTML(html: string) {
  const parser = new window.DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  if (doc.body && doc.body.firstChild instanceof HTMLImageElement) {
    return imageAttrsFromDOM(doc.body.firstChild, true);
  } else {
    return null;
  }
}

function imageCommand(editorUI: EditorUI, imageAttributes: boolean) {
  return (state: EditorState, dispatch?: (tr: Transaction<any>) => void, view?: EditorView) => {
    const schema = state.schema;

    if (!canInsertNode(state, schema.nodes.image) && !canInsertNode(state, schema.nodes.figure)) {
      return false;
    }

    if (dispatch && view) {
      // see if we are editing an existing node
      let node: ProsemirrorNode | null = null;
      let nodeType = schema.nodes.image;
      let img: HTMLImageElement | null = null;
      let imgDimensions: ImageDimensions | null = null;
      if (selectionIsImageNode(schema, state.selection)) {
        node = (state.selection as NodeSelection).node;
        nodeType = node.type;
        if (nodeType === schema.nodes.figure) {
          const figure = view.nodeDOM(state.selection.from) as HTMLElement;
          img = figure.firstChild!.firstChild as HTMLImageElement;
        } else {
          const span = view.nodeDOM(state.selection.from) as HTMLElement;
          img = span.firstChild! as HTMLImageElement;
        }
        if (img) {
          const containerWidth = imageContainerWidth(state.selection.from, view);
          imgDimensions = imageDimensionsFromImg(img, containerWidth);
        }
      }

      // see if we are in an empty paragraph (in that case insert a figure)
      if (selectionIsEmptyParagraph(schema, state.selection)) {
        nodeType = schema.nodes.figure;
      }

      // show dialog
      imageDialog(node, imgDimensions, nodeType, view, editorUI, imageAttributes);
    }

    return true;
  };
}

function readPandocTitle(title: string | null) {
  if (title) {
    return title.replace(/^(fig:)/, '');
  } else {
    return title;
  }
}

export default extension;
