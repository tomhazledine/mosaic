import { unified } from 'unified';
import markdown from 'remark-parse';
import remarkMdx from 'remark-mdx';
import { visit } from 'unist-util-visit';
import type { Node } from 'unist';
import type { Page, Plugin as PluginType } from '@jpmorganchase/mosaic-types';

type LeafNode = Node & {
  value: string;
};

interface SearchIndexPluginOptions {
  maxLineLength?: number;
  maxLineCount?: number;
  keys?: string[];
}

interface Optimization {
  content: string;
  title: string;
  maxLineCount: number;
  maxLineLength: number;
}

/**
 * Converts raw content string into an array of sentences suitable for inclusion
 * in the search index
 *
 * @param options.content the raw content string
 * @param options.title the title of the page  (used for adding context to parse errors)
 * @param options.maxLineLength the maximum length of a sentence (set this to match the
 * "location" option in your Fuse.js configuration). Sentences longer than this value will be
 * truncated.
 * @param options.maxLineCount the maximum number of lines to include in the search index for
 * each page. Pages with more lines than this value will be truncated.
 * @returns array of sentence strings
 */
const optimizeContentForSearch = async ({
  content,
  title,
  maxLineLength,
  maxLineCount
}: Optimization) => {
  if (!content || content.length < 1) return [content];
  const processor = unified().use(markdown).use(remarkMdx);
  let tree;

  try {
    tree = await processor.parse(content);
  } catch (err) {
    console.error(`Search Index Plugin failed to parse content for ${title}`, err.reason);
    return [];
  }

  const sentences: string[] = [];

  visit(
    tree,
    (node: Node) => node.type === 'text' || node.type === 'code',
    (node: LeafNode) => {
      if (maxLineLength) {
        sentences.push(node.value.slice(0, maxLineLength));
      } else {
        sentences.push(node.value);
      }
    }
  );

  if (maxLineLength) {
    return sentences.slice(0, maxLineCount);
  }
  return sentences;
};

/**
 * Creates a search-data.json file that contains all the information from a page that is required
 * to generate a search index
 */
const SearchIndexPlugin: PluginType<Page, SearchIndexPluginOptions> = {
  async afterUpdate(
    mutableFilesystem,
    { sharedFilesystem, serialiser, ignorePages },
    { maxLineLength, maxLineCount, keys }
  ) {
    const pages = await Promise.all(
      (
        (await mutableFilesystem.promises.glob('**', {
          onlyFiles: true,
          ignore: ignorePages.map(ignore => `**/${ignore}`),
          cwd: '/'
        })) as string[]
      ).map(async pagePath => {
        const deserialisedPage = await serialiser.deserialise(
          pagePath,
          await mutableFilesystem.promises.readFile(pagePath)
        );
        return deserialisedPage;
      })
    );

    const searchData = await Promise.all(
      pages.map(async page => {
        const content = await optimizeContentForSearch({
          content: page.content || '',
          title: page.title || '',
          maxLineLength,
          maxLineCount
        });
        const defaultResults = {
          title: page.title,
          content,
          route: page.route
        };

        if (keys && keys.length > 0) {
          const extendedResults = keys.reduce((acc, key) => ({ ...acc, [key]: page[key] }), {});
          return { ...defaultResults, ...extendedResults };
        }

        return defaultResults;
      })
    );

    await sharedFilesystem.promises.writeFile('/search-data.json', JSON.stringify(searchData));
  }
};

export default SearchIndexPlugin;