/**
 * Unsplash API Proxy
 *
 * Server-side proxy to hide the Unsplash API key from clients.
 * Handles search requests and download tracking (required by Unsplash API terms).
 *
 * GET /api/unsplash?q=search_term&page=1 - Search photos
 * POST /api/unsplash (with downloadUrl in body) - Trigger download tracking
 */

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

export const loader = async ({ request }) => {
  if (!UNSPLASH_ACCESS_KEY) {
    return Response.json(
      { error: 'Unsplash API not configured' },
      { status: 503 }
    );
  }

  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  const page = url.searchParams.get('page') || '1';
  const perPage = url.searchParams.get('per_page') || '12';

  if (!query) {
    return Response.json(
      { error: 'Missing search query parameter (q)' },
      { status: 400 }
    );
  }

  try {
    const searchUrl = new URL('https://api.unsplash.com/search/photos');
    searchUrl.searchParams.set('query', query);
    searchUrl.searchParams.set('page', page);
    searchUrl.searchParams.set('per_page', perPage);
    searchUrl.searchParams.set('orientation', 'landscape'); // Better for headers

    const response = await fetch(searchUrl.toString(), {
      headers: {
        Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Unsplash API error:', response.status, errorText);
      return Response.json(
        { error: 'Unsplash API request failed' },
        { status: response.status }
      );
    }

    const data = await response.json();

    // Return simplified photo data
    const photos = data.results.map(photo => ({
      id: photo.id,
      url: photo.urls.regular, // Good quality for display
      thumb: photo.urls.thumb, // For grid preview
      full: photo.urls.full, // Full resolution
      alt: photo.alt_description || photo.description || 'Unsplash photo',
      photographer: {
        name: photo.user.name,
        username: photo.user.username,
        link: photo.user.links.html,
      },
      downloadUrl: photo.links.download_location, // Must call this when using photo
      color: photo.color, // Dominant color for placeholder
      width: photo.width,
      height: photo.height,
    }));

    return Response.json({
      photos,
      total: data.total,
      totalPages: data.total_pages,
      page: parseInt(page),
    });
  } catch (error) {
    console.error('Unsplash search error:', error);
    return Response.json(
      { error: 'Failed to search Unsplash' },
      { status: 500 }
    );
  }
};

/**
 * Action handler for triggering Unsplash download tracking.
 * Per Unsplash API guidelines, we MUST call the download endpoint when a photo is used.
 */
export const action = async ({ request }) => {
  if (!UNSPLASH_ACCESS_KEY) {
    return Response.json(
      { error: 'Unsplash API not configured' },
      { status: 503 }
    );
  }

  const formData = await request.formData();
  const downloadUrl = formData.get('downloadUrl');

  if (!downloadUrl) {
    return Response.json(
      { error: 'Missing downloadUrl' },
      { status: 400 }
    );
  }

  try {
    // Trigger the download endpoint (required by Unsplash API terms)
    // This doesn't actually download the image, just tracks usage
    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`,
      },
    });

    if (!response.ok) {
      console.error('Unsplash download tracking failed:', response.status);
      // Don't fail the request - the photo can still be used
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('Unsplash download tracking error:', error);
    // Don't fail the request - the photo can still be used
    return Response.json({ success: true });
  }
};
