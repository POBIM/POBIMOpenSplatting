import { NextRequest } from 'next/server';

const API_BASE_URL = (process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000').replace(/\/$/, '');

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const response = await fetch(`${API_BASE_URL}/api/projects/${id}`, {
      cache: 'no-store',
    });

    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch (error) {
    return Response.json({ error: 'Failed to fetch project' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const response = await fetch(`${API_BASE_URL}/api/projects/${id}`, {
      method: 'DELETE',
    });

    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch (error) {
    return Response.json({ error: 'Delete failed' }, { status: 500 });
  }
}
