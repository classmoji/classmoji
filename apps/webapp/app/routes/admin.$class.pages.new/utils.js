import JSZip from 'jszip';

/**
 * Extract image references from markdown (client-side)
 * Handles paths with parentheses and URL-encoded characters
 */
export function extractImageReferencesClient(markdown) {
  // Match image syntax - use greedy match up to .extension)
  // This handles paths like: Short%202%20Starterpack%20(Vite)/image.png
  // The key is matching .*? (non-greedy) followed by the extension and closing paren
  const imageRegex = /!\[([^\]]*)\]\((.*?\.(?:png|jpg|jpeg|gif|svg|webp))\)/gi;
  const images = [];
  let match;

  while ((match = imageRegex.exec(markdown)) !== null) {
    let path = match[2];
    // Decode URL-encoded paths
    try {
      path = decodeURIComponent(path);
    } catch {
      // If decoding fails, use as-is
    }
    images.push({
      alt: match[1],
      path: path,
      filename: path.split('/').pop().toLowerCase(),
    });
  }

  return images;
}

/**
 * Extract contents from a ZIP file (handles nested ZIPs)
 */
export async function extractZipContents(file) {
  let zip = await JSZip.loadAsync(file);
  let files = Object.values(zip.files);

  // Check for nested ZIP files and extract them
  const nestedZips = files.filter(f => !f.dir && f.name.toLowerCase().endsWith('.zip'));
  if (nestedZips.length > 0) {
    const nestedZipBlob = await nestedZips[0].async('blob');
    zip = await JSZip.loadAsync(nestedZipBlob);
    files = Object.values(zip.files);
  }

  // Find markdown file (first .md)
  const mdFiles = files.filter(f => !f.dir && f.name.endsWith('.md'));
  const markdownEntry = mdFiles[0];

  // Find all image files (recursively, handles subfolders)
  const imageEntries = files.filter(
    f => !f.dir && /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(f.name)
  );

  if (!markdownEntry) {
    throw new Error('No markdown file (.md) found in ZIP');
  }

  // Extract markdown content as UTF-8
  // Use uint8array and TextDecoder to ensure proper UTF-8 decoding
  const markdownBytes = await markdownEntry.async('uint8array');
  const decoder = new TextDecoder('utf-8');
  const markdownContent = decoder.decode(markdownBytes);
  const markdownFileName = markdownEntry.name.split('/').pop();

  // Extract images as File objects
  const imageFiles = await Promise.all(
    imageEntries.map(async entry => {
      const blob = await entry.async('blob');
      const fileName = entry.name.split('/').pop(); // Use basename only
      return new File([blob], fileName, { type: blob.type || 'image/png' });
    })
  );

  return {
    markdownContent,
    markdownFileName,
    imageFiles,
  };
}

// Generate initial page content with minimal markdown
export function generatePageTemplate(title) {
  return `Add your content here...\n`;
}

/**
 * Extract first H1 from markdown for use as title (client-side version)
 * Cleans up Notion-specific artifacts like HTML comments
 */
export function extractTitleFromMarkdown(markdown) {
  const h1Match = markdown.match(/^#\s+(.+)$/m);
  if (!h1Match) return null;

  let title = h1Match[1].trim();

  // Remove Notion HTML comments (e.g., <!-- notionvc: b57374d5-409e-4c35-a161-1df68a673c08 -->)
  title = title.replace(/<!--[\s\S]*?-->/g, '').trim();

  return title;
}
