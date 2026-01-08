"""
ArUco Marker Generator for Room/Space Scanning
Generates printable ArUco markers to improve COLMAP reconstruction quality
for indoor spaces with texture-less surfaces.
"""

import cv2
import numpy as np
from pathlib import Path
from typing import List, Tuple, Optional
import io

# ArUco dictionary options
ARUCO_DICTS = {
    '4x4_50': cv2.aruco.DICT_4X4_50,
    '4x4_100': cv2.aruco.DICT_4X4_100,
    '4x4_250': cv2.aruco.DICT_4X4_250,
    '5x5_50': cv2.aruco.DICT_5X5_50,
    '5x5_100': cv2.aruco.DICT_5X5_100,
    '5x5_250': cv2.aruco.DICT_5X5_250,
    '6x6_50': cv2.aruco.DICT_6X6_50,
    '6x6_100': cv2.aruco.DICT_6X6_100,
    '6x6_250': cv2.aruco.DICT_6X6_250,
    '7x7_50': cv2.aruco.DICT_7X7_50,
    '7x7_100': cv2.aruco.DICT_7X7_100,
    '7x7_250': cv2.aruco.DICT_7X7_250,
}

# Default: 6x6 is good balance between detection distance and uniqueness
DEFAULT_DICT = '6x6_250'


def get_aruco_dict(dict_name: str = DEFAULT_DICT):
    """Get ArUco dictionary by name."""
    if dict_name not in ARUCO_DICTS:
        dict_name = DEFAULT_DICT
    return cv2.aruco.getPredefinedDictionary(ARUCO_DICTS[dict_name])


def generate_single_marker(
    marker_id: int,
    size_pixels: int = 200,
    dict_name: str = DEFAULT_DICT,
    border_bits: int = 1
) -> np.ndarray:
    """
    Generate a single ArUco marker image.
    
    Args:
        marker_id: Unique ID for the marker (0 to max based on dictionary)
        size_pixels: Size of the marker in pixels
        dict_name: ArUco dictionary name
        border_bits: Width of the white border in bits
        
    Returns:
        numpy array of the marker image (grayscale)
    """
    aruco_dict = get_aruco_dict(dict_name)
    marker_img = cv2.aruco.generateImageMarker(aruco_dict, marker_id, size_pixels)
    
    # Add white border
    if border_bits > 0:
        border_size = int(size_pixels * border_bits / 6)  # Approximate border
        bordered = np.ones((size_pixels + 2*border_size, size_pixels + 2*border_size), dtype=np.uint8) * 255
        bordered[border_size:border_size+size_pixels, border_size:border_size+size_pixels] = marker_img
        marker_img = bordered
    
    return marker_img


def generate_marker_with_label(
    marker_id: int,
    size_pixels: int = 200,
    dict_name: str = DEFAULT_DICT,
    show_id: bool = True,
    show_size_guide: bool = True,
    marker_size_cm: float = 10.0
) -> np.ndarray:
    """
    Generate a marker with ID label and size guide.
    
    Args:
        marker_id: Unique ID for the marker
        size_pixels: Size of the marker in pixels
        dict_name: ArUco dictionary name
        show_id: Whether to show the marker ID
        show_size_guide: Whether to show the size in cm
        marker_size_cm: Physical size of the marker in centimeters
        
    Returns:
        numpy array of the marker image with labels (BGR)
    """
    # Generate base marker
    marker = generate_single_marker(marker_id, size_pixels, dict_name)
    
    # Convert to BGR for colored text
    marker_bgr = cv2.cvtColor(marker, cv2.COLOR_GRAY2BGR)
    
    # Calculate label area height
    label_height = 40 if show_id else 0
    size_guide_height = 25 if show_size_guide else 0
    total_height = marker_bgr.shape[0] + label_height + size_guide_height
    
    # Create final image with white background
    final_img = np.ones((total_height, marker_bgr.shape[1], 3), dtype=np.uint8) * 255
    
    # Place marker
    y_offset = label_height
    final_img[y_offset:y_offset+marker_bgr.shape[0], :] = marker_bgr
    
    # Add ID label on top
    if show_id:
        text = f"ID: {marker_id}"
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.7
        thickness = 2
        text_size = cv2.getTextSize(text, font, font_scale, thickness)[0]
        text_x = (final_img.shape[1] - text_size[0]) // 2
        text_y = 28
        cv2.putText(final_img, text, (text_x, text_y), font, font_scale, (0, 0, 0), thickness)
    
    # Add size guide at bottom
    if show_size_guide:
        text = f"{marker_size_cm:.1f} cm"
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.5
        thickness = 1
        text_size = cv2.getTextSize(text, font, font_scale, thickness)[0]
        text_x = (final_img.shape[1] - text_size[0]) // 2
        text_y = total_height - 8
        cv2.putText(final_img, text, (text_x, text_y), font, font_scale, (100, 100, 100), thickness)
    
    return final_img


def generate_marker_sheet(
    start_id: int = 0,
    count: int = 12,
    markers_per_row: int = 4,
    marker_size_pixels: int = 200,
    marker_size_cm: float = 10.0,
    dict_name: str = DEFAULT_DICT,
    page_size: Tuple[int, int] = (2480, 3508),  # A4 at 300 DPI
    margin: int = 100
) -> np.ndarray:
    """
    Generate a printable sheet of ArUco markers.
    
    Args:
        start_id: Starting marker ID
        count: Number of markers to generate
        markers_per_row: Markers per row
        marker_size_pixels: Size of each marker in pixels
        marker_size_cm: Physical size of markers in cm
        dict_name: ArUco dictionary name
        page_size: Page size in pixels (width, height)
        margin: Page margin in pixels
        
    Returns:
        numpy array of the marker sheet image (BGR)
    """
    page_width, page_height = page_size
    
    # Generate individual markers
    markers = []
    for i in range(count):
        marker_id = start_id + i
        marker = generate_marker_with_label(
            marker_id, 
            marker_size_pixels, 
            dict_name,
            show_id=True,
            show_size_guide=True,
            marker_size_cm=marker_size_cm
        )
        markers.append(marker)
    
    if not markers:
        return np.ones((page_height, page_width, 3), dtype=np.uint8) * 255
    
    # Calculate layout
    marker_height, marker_width = markers[0].shape[:2]
    rows = (count + markers_per_row - 1) // markers_per_row
    
    # Calculate spacing
    available_width = page_width - 2 * margin
    available_height = page_height - 2 * margin - 150  # Reserve space for title
    
    h_spacing = (available_width - markers_per_row * marker_width) // max(1, markers_per_row - 1) if markers_per_row > 1 else 0
    v_spacing = (available_height - rows * marker_height) // max(1, rows - 1) if rows > 1 else 0
    
    # Ensure minimum spacing
    h_spacing = max(20, min(h_spacing, 100))
    v_spacing = max(20, min(v_spacing, 80))
    
    # Create page
    page = np.ones((page_height, page_width, 3), dtype=np.uint8) * 255
    
    # Add title
    title = "ArUco Markers for 3D Scanning"
    subtitle = f"Dictionary: {dict_name} | Size: {marker_size_cm} cm | IDs: {start_id}-{start_id + count - 1}"
    
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(page, title, (margin, 60), font, 1.2, (0, 0, 0), 2)
    cv2.putText(page, subtitle, (margin, 100), font, 0.6, (100, 100, 100), 1)
    
    # Add instructions
    instructions = [
        "Instructions:",
        "1. Print at 100% scale (no scaling)",
        "2. Place markers on walls, floor, and corners",
        "3. Keep markers flat and visible",
        "4. Ensure even lighting on markers"
    ]
    y_pos = page_height - 120
    for instruction in instructions:
        cv2.putText(page, instruction, (margin, y_pos), font, 0.45, (80, 80, 80), 1)
        y_pos += 22
    
    # Place markers on page
    y_start = 150
    for idx, marker in enumerate(markers):
        row = idx // markers_per_row
        col = idx % markers_per_row
        
        x = margin + col * (marker_width + h_spacing)
        y = y_start + row * (marker_height + v_spacing)
        
        # Check bounds
        if y + marker_height > page_height - 150:
            break
            
        # Place marker
        page[y:y+marker_height, x:x+marker_width] = marker
    
    return page


def generate_floor_markers(
    count: int = 20,
    marker_size_cm: float = 15.0,
    dict_name: str = DEFAULT_DICT
) -> List[np.ndarray]:
    """
    Generate larger markers suitable for floor placement.
    """
    markers = []
    # Larger size for floor visibility
    size_pixels = 400
    
    for i in range(count):
        marker = generate_marker_with_label(
            i, 
            size_pixels, 
            dict_name,
            show_id=True,
            show_size_guide=True,
            marker_size_cm=marker_size_cm
        )
        markers.append(marker)
    
    return markers


def generate_corner_markers(
    count: int = 8,
    marker_size_cm: float = 8.0,
    dict_name: str = DEFAULT_DICT
) -> List[np.ndarray]:
    """
    Generate smaller markers for corner placement.
    Uses different ID range (100+) to distinguish from floor markers.
    """
    markers = []
    size_pixels = 200
    
    for i in range(count):
        marker = generate_marker_with_label(
            100 + i,  # Different ID range
            size_pixels, 
            dict_name,
            show_id=True,
            show_size_guide=True,
            marker_size_cm=marker_size_cm
        )
        markers.append(marker)
    
    return markers


def save_marker_sheet_pdf(
    output_path: Path,
    start_id: int = 0,
    count: int = 24,
    marker_size_cm: float = 10.0,
    dict_name: str = DEFAULT_DICT
) -> Path:
    """
    Save marker sheets as images (can be converted to PDF).
    
    Returns path to the generated file.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Generate sheets (12 markers per A4 page)
    markers_per_page = 12
    pages = []
    
    for page_num in range((count + markers_per_page - 1) // markers_per_page):
        page_start_id = start_id + page_num * markers_per_page
        page_count = min(markers_per_page, count - page_num * markers_per_page)
        
        sheet = generate_marker_sheet(
            start_id=page_start_id,
            count=page_count,
            marker_size_cm=marker_size_cm,
            dict_name=dict_name
        )
        pages.append(sheet)
    
    # Save as PNG (single page) or multiple PNGs
    if len(pages) == 1:
        cv2.imwrite(str(output_path), pages[0])
    else:
        # Save multiple pages
        base_name = output_path.stem
        for i, page in enumerate(pages):
            page_path = output_path.parent / f"{base_name}_page{i+1}.png"
            cv2.imwrite(str(page_path), page)
    
    return output_path


def get_marker_image_bytes(
    marker_id: int,
    size_pixels: int = 200,
    dict_name: str = DEFAULT_DICT,
    format: str = 'png'
) -> bytes:
    """
    Get marker image as bytes for web response.
    """
    marker = generate_marker_with_label(marker_id, size_pixels, dict_name)
    
    if format.lower() == 'png':
        _, buffer = cv2.imencode('.png', marker)
    else:
        _, buffer = cv2.imencode('.jpg', marker, [cv2.IMWRITE_JPEG_QUALITY, 95])
    
    return buffer.tobytes()


def get_marker_sheet_bytes(
    start_id: int = 0,
    count: int = 12,
    marker_size_cm: float = 10.0,
    dict_name: str = DEFAULT_DICT,
    format: str = 'png'
) -> bytes:
    """
    Get marker sheet image as bytes for web response.
    """
    sheet = generate_marker_sheet(
        start_id=start_id,
        count=count,
        marker_size_cm=marker_size_cm,
        dict_name=dict_name
    )
    
    if format.lower() == 'png':
        _, buffer = cv2.imencode('.png', sheet)
    else:
        _, buffer = cv2.imencode('.jpg', sheet, [cv2.IMWRITE_JPEG_QUALITY, 95])
    
    return buffer.tobytes()


def get_marker_sheet_pdf_bytes(
    start_id: int = 0,
    count: int = 12,
    marker_size_cm: float = 10.0,
    dict_name: str = DEFAULT_DICT
) -> bytes:
    """
    Generate marker sheet as PDF bytes for accurate A4 printing.
    Uses reportlab for precise PDF generation.
    Includes placement recommendations under each marker.
    """
    # Placement recommendations for each marker ID (12 markers setup)
    PLACEMENT_GUIDE = {
        0: ("🟢 พื้น มุม 1", "Floor corner 1", "0-10 cm"),
        1: ("🟢 พื้น มุม 2", "Floor corner 2", "0-10 cm"),
        2: ("🟢 พื้น กลางห้อง", "Floor center", "0 cm"),
        3: ("🔵 ผนัง A ต่ำ", "Wall A low", "30-50 cm"),
        4: ("🔵 ผนัง B ต่ำ", "Wall B low", "30-50 cm"),
        5: ("🔵 ผนัง C ต่ำ", "Wall C low", "30-50 cm"),
        6: ("🟣 ผนัง A กลาง", "Wall A mid", "100-120 cm"),
        7: ("🟣 ผนัง B กลาง", "Wall B mid", "100-120 cm"),
        8: ("🟣 ผนัง C กลาง", "Wall C mid", "100-120 cm"),
        9: ("🟠 ผนัง A สูง", "Wall A high", "170-200 cm"),
        10: ("🟠 ผนัง B สูง", "Wall B high", "170-200 cm"),
        11: ("🟠 ผนัง C สูง", "Wall C high", "170-200 cm"),
    }
    
    def get_placement_info(marker_id: int):
        """Get placement info for a marker, with fallback for IDs > 11"""
        if marker_id in PLACEMENT_GUIDE:
            return PLACEMENT_GUIDE[marker_id]
        else:
            # For IDs beyond 12, give generic advice based on position
            idx = marker_id % 12
            if idx < 3:
                return (f"🟢 พื้น #{marker_id}", f"Floor #{marker_id}", "0-10 cm")
            elif idx < 6:
                return (f"🔵 ผนังต่ำ #{marker_id}", f"Wall low #{marker_id}", "30-50 cm")
            elif idx < 9:
                return (f"🟣 ผนังกลาง #{marker_id}", f"Wall mid #{marker_id}", "100-120 cm")
            else:
                return (f"🟠 ผนังสูง #{marker_id}", f"Wall high #{marker_id}", "170-200 cm")
    
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.units import cm, mm
        from reportlab.pdfgen import canvas
        from reportlab.lib.utils import ImageReader
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from PIL import Image
        import io
        
        # A4 dimensions
        page_width, page_height = A4  # 595.27, 841.89 points (72 points = 1 inch)
        
        # Create PDF buffer
        pdf_buffer = io.BytesIO()
        c = canvas.Canvas(pdf_buffer, pagesize=A4)
        
        # Margins
        margin_x = 1.5 * cm
        margin_y = 1.5 * cm
        
        # Calculate marker size in points (1 cm = 28.35 points)
        marker_size_pt = marker_size_cm * 28.35
        
        # Add more space for placement guide text
        cell_padding = 0.8 * cm
        cell_width = marker_size_pt + cell_padding
        cell_height = marker_size_pt + 2.0 * cm  # Extra space for placement labels
        
        # Calculate grid
        usable_width = page_width - 2 * margin_x
        usable_height = page_height - 2 * margin_y - 3 * cm  # Reserve for header/footer
        
        cols = int(usable_width / cell_width)
        rows = int(usable_height / cell_height)
        markers_per_page = cols * rows
        
        # Ensure at least 2x2 grid
        cols = max(2, cols)
        rows = max(2, rows)
        markers_per_page = cols * rows
        
        # Recalculate cell size to fit nicely
        cell_width = usable_width / cols
        cell_height = (usable_height - 1*cm) / rows
        
        # Total pages needed
        total_pages = (count + markers_per_page - 1) // markers_per_page
        
        aruco_dict = get_aruco_dict(dict_name)
        
        for page_num in range(total_pages):
            if page_num > 0:
                c.showPage()
            
            # Header
            c.setFont("Helvetica-Bold", 14)
            c.drawString(margin_x, page_height - margin_y, "ArUco Markers for 3D Scanning")
            
            c.setFont("Helvetica", 9)
            page_start = start_id + page_num * markers_per_page
            page_end = min(page_start + markers_per_page - 1, start_id + count - 1)
            c.drawString(margin_x, page_height - margin_y - 0.5*cm, 
                        f"Dictionary: {dict_name} | Size: {marker_size_cm} cm | IDs: {page_start}-{page_end} | Page {page_num+1}/{total_pages}")
            
            # Draw markers
            y_start = page_height - margin_y - 1.8*cm
            
            for idx in range(markers_per_page):
                marker_idx = page_num * markers_per_page + idx
                if marker_idx >= count:
                    break
                
                marker_id = start_id + marker_idx
                row = idx // cols
                col = idx % cols
                
                x = margin_x + col * cell_width + (cell_width - marker_size_pt) / 2
                y = y_start - row * cell_height - marker_size_pt
                
                # Generate marker image
                marker_img = cv2.aruco.generateImageMarker(aruco_dict, marker_id, 200)
                
                # Add white border
                border = 20
                bordered = np.ones((240, 240), dtype=np.uint8) * 255
                bordered[border:border+200, border:border+200] = marker_img
                
                # Convert to PIL Image
                pil_img = Image.fromarray(bordered)
                img_buffer = io.BytesIO()
                pil_img.save(img_buffer, format='PNG')
                img_buffer.seek(0)
                
                # Draw marker
                c.drawImage(ImageReader(img_buffer), x, y, 
                           width=marker_size_pt, height=marker_size_pt)
                
                # Draw ID label below marker
                c.setFont("Helvetica-Bold", 8)
                label = f"ID: {marker_id}"
                label_width = c.stringWidth(label, "Helvetica-Bold", 8)
                c.drawString(x + (marker_size_pt - label_width) / 2, y - 0.35*cm, label)
                
                # Get placement recommendation
                placement_th, placement_en, height_cm = get_placement_info(marker_id)
                
                # Draw placement recommendation (English + Height)
                c.setFont("Helvetica", 6)
                c.setFillColorRGB(0.2, 0.4, 0.7)  # Blue color
                placement_text = f"{placement_en}"
                placement_width = c.stringWidth(placement_text, "Helvetica", 6)
                c.drawString(x + (marker_size_pt - placement_width) / 2, y - 0.6*cm, placement_text)
                
                # Draw height recommendation
                c.setFillColorRGB(0.4, 0.6, 0.3)  # Green color
                height_text = f"Height: {height_cm}"
                height_width = c.stringWidth(height_text, "Helvetica", 6)
                c.drawString(x + (marker_size_pt - height_width) / 2, y - 0.85*cm, height_text)
                
                # Draw size indicator
                c.setFont("Helvetica", 5)
                c.setFillColorRGB(0.5, 0.5, 0.5)
                size_label = f"({marker_size_cm} cm)"
                size_width = c.stringWidth(size_label, "Helvetica", 5)
                c.drawString(x + (marker_size_pt - size_width) / 2, y - 1.05*cm, size_label)
                c.setFillColorRGB(0, 0, 0)
            
            # Footer with instructions
            c.setFont("Helvetica", 7)
            c.setFillColorRGB(0.3, 0.3, 0.3)
            footer_y = margin_y
            c.drawString(margin_x, footer_y + 0.8*cm, "Instructions: Print at 100% scale (no scaling). Place markers on walls, floor, and corners.")
            c.drawString(margin_x, footer_y + 0.3*cm, "Ensure at least 3-4 markers visible per photo. Keep markers flat and avoid curved surfaces.")
            c.setFillColorRGB(0, 0, 0)
        
        c.save()
        pdf_buffer.seek(0)
        return pdf_buffer.getvalue()
        
    except ImportError:
        # Fallback: return PNG if reportlab not available
        print("Warning: reportlab not installed, falling back to PNG")
        return get_marker_sheet_bytes(start_id, count, marker_size_cm, dict_name, 'png')


# Detection functions
def detect_aruco_markers(image: np.ndarray, dict_name: str = DEFAULT_DICT):
    """
    Detect ArUco markers in an image.
    
    Args:
        image: Input image (BGR or grayscale)
        dict_name: ArUco dictionary name
        
    Returns:
        corners: List of marker corners
        ids: Array of marker IDs
        rejected: Rejected candidates
    """
    aruco_dict = get_aruco_dict(dict_name)
    parameters = cv2.aruco.DetectorParameters()
    
    # Optimize for various conditions
    parameters.adaptiveThreshConstant = 7
    parameters.adaptiveThreshWinSizeMin = 3
    parameters.adaptiveThreshWinSizeMax = 23
    parameters.adaptiveThreshWinSizeStep = 10
    parameters.minMarkerPerimeterRate = 0.03
    parameters.maxMarkerPerimeterRate = 4.0
    parameters.polygonalApproxAccuracyRate = 0.05
    parameters.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    
    detector = cv2.aruco.ArucoDetector(aruco_dict, parameters)
    
    # Convert to grayscale if needed
    if len(image.shape) == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image
    
    corners, ids, rejected = detector.detectMarkers(gray)
    
    return corners, ids, rejected


def draw_detected_markers(
    image: np.ndarray,
    corners,
    ids,
    draw_ids: bool = True
) -> np.ndarray:
    """
    Draw detected markers on image.
    """
    output = image.copy()
    
    if ids is not None and len(ids) > 0:
        cv2.aruco.drawDetectedMarkers(output, corners, ids)
        
        if draw_ids:
            for i, corner in enumerate(corners):
                # Draw ID near marker
                center = corner[0].mean(axis=0).astype(int)
                cv2.putText(output, f"ID:{ids[i][0]}", 
                           (center[0]-20, center[1]-20),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
    
    return output


def analyze_marker_coverage(
    image: np.ndarray,
    dict_name: str = DEFAULT_DICT
) -> dict:
    """
    Analyze marker detection in an image for quality feedback.
    
    Returns:
        Dictionary with detection statistics
    """
    corners, ids, rejected = detect_aruco_markers(image, dict_name)
    
    result = {
        'detected_count': len(ids) if ids is not None else 0,
        'detected_ids': ids.flatten().tolist() if ids is not None else [],
        'rejected_count': len(rejected),
        'image_size': image.shape[:2],
        'coverage_quality': 'unknown'
    }
    
    # Assess quality
    detected = result['detected_count']
    if detected >= 6:
        result['coverage_quality'] = 'excellent'
    elif detected >= 4:
        result['coverage_quality'] = 'good'
    elif detected >= 2:
        result['coverage_quality'] = 'fair'
    elif detected >= 1:
        result['coverage_quality'] = 'poor'
    else:
        result['coverage_quality'] = 'none'
    
    # Calculate marker positions for spatial distribution
    if ids is not None and len(ids) > 0:
        centers = []
        for corner in corners:
            center = corner[0].mean(axis=0)
            centers.append(center.tolist())
        result['marker_centers'] = centers
        
        # Check distribution across image quadrants
        h, w = image.shape[:2]
        quadrants = [False, False, False, False]  # TL, TR, BL, BR
        for cx, cy in centers:
            if cx < w/2 and cy < h/2:
                quadrants[0] = True
            elif cx >= w/2 and cy < h/2:
                quadrants[1] = True
            elif cx < w/2 and cy >= h/2:
                quadrants[2] = True
            else:
                quadrants[3] = True
        
        result['quadrant_coverage'] = sum(quadrants)
        result['well_distributed'] = sum(quadrants) >= 3
    
    return result


if __name__ == '__main__':
    # Test marker generation
    import tempfile
    
    # Generate test sheet
    output_dir = Path(tempfile.gettempdir()) / 'aruco_test'
    output_dir.mkdir(exist_ok=True)
    
    # Generate standard sheet
    sheet = generate_marker_sheet(start_id=0, count=12, marker_size_cm=10.0)
    cv2.imwrite(str(output_dir / 'markers_standard.png'), sheet)
    
    # Generate floor markers
    floor_sheet = generate_marker_sheet(start_id=0, count=6, marker_size_cm=15.0, markers_per_row=3)
    cv2.imwrite(str(output_dir / 'markers_floor.png'), floor_sheet)
    
    print(f"Test markers saved to: {output_dir}")
