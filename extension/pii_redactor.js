/**
 * SIH26171 — Client-Side Privacy Redactor (ISRO PS Requirement)
 * Redacts passwords, CVVs, Aadhaar, PAN, and sensitive text directly on
 * an HTML5 Canvas before screenshot image data is transmitted.
 */
(function(window) {
  'use strict';

  class PIIRedactor {
    /**
     * Takes an image data URL / base64 and sensitive bounding boxes,
     * and returns a sanitized base64 PNG with solid black security masks
     * and a redaction audit report.
     */
    static async redactScreenshot(imageBase64, sensitiveNodes = []) {
      if (!imageBase64 || sensitiveNodes.length === 0) {
        return {
          sanitized_image_base64: imageBase64,
          audit_report: { total_pii_detected: 0, regions_masked: 0, timestamp: Date.now() }
        };
      }

      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            return resolve({
              sanitized_image_base64: imageBase64,
              audit_report: { total_pii_detected: sensitiveNodes.length, regions_masked: 0, timestamp: Date.now() }
            });
          }

          // Draw original screenshot
          ctx.drawImage(img, 0, 0);

          const scaleX = img.width / window.innerWidth;
          const scaleY = img.height / window.innerHeight;
          let maskedCount = 0;

          // Mask each sensitive region
          for (const node of sensitiveNodes) {
            const bbox = node.bbox;
            if (!bbox || bbox.w <= 0 || bbox.h <= 0) continue;

            const rx = bbox.x * scaleX;
            const ry = bbox.y * scaleY;
            const rw = bbox.w * scaleX;
            const rh = bbox.h * scaleY;

            // Draw solid blackout rectangle
            ctx.fillStyle = '#0f172a'; // Deep slate black
            ctx.fillRect(rx - 2, ry - 2, rw + 4, rh + 4);

            // Draw security border and label
            ctx.strokeStyle = '#f43f5e'; // Rose security border
            ctx.lineWidth = 2;
            ctx.strokeRect(rx - 2, ry - 2, rw + 4, rh + 4);

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 11px sans-serif';
            ctx.fillText(`🛡️ [PROTECTED: ${node.type}]`, rx + 4, ry + Math.min(rh - 4, 14));

            maskedCount++;
          }

          const sanitizedDataUrl = canvas.toDataURL('image/png');
          const sanitizedBase64 = sanitizedDataUrl.replace(/^data:image\/png;base64,/, '');

          resolve({
            sanitized_image_base64: sanitizedBase64,
            audit_report: {
              total_pii_detected: sensitiveNodes.length,
              regions_masked: maskedCount,
              types: [...new Set(sensitiveNodes.map(n => n.type))],
              timestamp: Date.now()
            }
          });
        };

        img.onerror = () => {
          resolve({
            sanitized_image_base64: imageBase64,
            audit_report: { total_pii_detected: 0, regions_masked: 0, error: 'Failed to load image', timestamp: Date.now() }
          });
        };

        img.src = imageBase64.startsWith('data:') ? imageBase64 : `data:image/png;base64,${imageBase64}`;
      });
    }
  }

  window.PIIRedactor = PIIRedactor;
})(typeof window !== 'undefined' ? window : this);
