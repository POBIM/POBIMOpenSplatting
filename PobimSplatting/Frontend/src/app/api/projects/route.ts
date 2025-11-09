const API_BASE_URL = (process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000').replace(/\/$/, '');

export async function GET() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/projects`);
    const data = await response.json();
    return Response.json(data);
  } catch (error) {
    return Response.json({ error: 'Backend unavailable' }, { status: 500 });
  }
}
