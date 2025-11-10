import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  try {
    const body = await request.json();

    // Forward request to Flask backend
    const response = await fetch(
      `${BACKEND_URL}/api/project/${projectId}/create_textured_mesh`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Mesh export error:', error);
    return NextResponse.json(
      { error: 'Failed to create textured mesh', details: error.message },
      { status: 500 }
    );
  }
}
