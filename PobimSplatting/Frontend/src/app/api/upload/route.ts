const API_BASE_URL = (process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000').replace(/\/$/, '');

export async function POST(request: Request) {
  try {
    const formData = await request.formData();

    // Create a new FormData to properly forward to backend
    const backendFormData = new FormData();

    // Copy all fields from the original formData
    for (const [key, value] of formData.entries()) {
      backendFormData.append(key, value);
    }

    const response = await fetch(`${API_BASE_URL}/api/upload`, {
      method: 'POST',
      body: backendFormData,
      // Don't set Content-Type, let fetch set it with boundary
    });

    if (!response.ok) {
      const errorData = await response.json();
      return Response.json(errorData, { status: response.status });
    }

    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch (error) {
    console.error('Upload proxy error:', error);
    return Response.json({
      error: 'Upload failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
