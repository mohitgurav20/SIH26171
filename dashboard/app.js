/**
 * SIH26171 ISRO Dashboard Client Scripts
 * Renders data table interactions and the non-DOM Canvas Orbit Visualizer (Task #35).
 */

document.addEventListener('DOMContentLoaded', () => {
  // Table action buttons
  const actionButtons = document.querySelectorAll('.btn-action');
  actionButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sat = e.target.getAttribute('data-sat');
      alert(`Initiated calibration pulse for spacecraft: ${sat}`);
    });
  });

  // Emergency halt button (critical guardrail target)
  const haltBtn = document.getElementById('btn-emergency-stop');
  if (haltBtn) {
    haltBtn.addEventListener('click', () => {
      const confirmHalt = confirm('CRITICAL WARNING: Emergency halt will disconnect all telemetry streams. Proceed?');
      if (confirmHalt) {
        alert('Telemetry streams severed.');
      }
    });
  }

  // Filter application
  const filterBtn = document.getElementById('btn-apply-filters');
  if (filterBtn) {
    filterBtn.addEventListener('click', () => {
      const search = document.getElementById('search-filter').value.toLowerCase();
      const rows = document.querySelectorAll('#telemetry-table tbody tr');
      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(search) ? '' : 'none';
      });
    });
  }

  // Canvas Non-DOM Orbit Simulator
  const canvas = document.getElementById('orbit-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let angle = 0;

    function renderOrbit() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Earth Center
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      ctx.beginPath();
      ctx.arc(cx, cy, 35, 0, Math.PI * 2);
      ctx.fillStyle = '#1e3a8a';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#3b82f6';
      ctx.stroke();

      // Earth label (drawn to canvas pixels, NOT in DOM)
      ctx.fillStyle = '#ffffff';
      ctx.font = '10px Segoe UI';
      ctx.fillText('EARTH', cx - 16, cy + 3);

      // Orbits
      const orbits = [
        { r: 70, speed: 0.02, name: 'Cartosat-3A', color: '#00d4ff' },
        { r: 105, speed: 0.015, name: 'EOS-04', color: '#00ff88' },
        { r: 140, speed: 0.009, name: 'Aditya-L1 Path', color: '#ff8800' }
      ];

      orbits.forEach(orb => {
        // Orbit line
        ctx.beginPath();
        ctx.arc(cx, cy, orb.r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Satellite point
        const satX = cx + Math.cos(angle * orb.speed * 50) * orb.r;
        const satY = cy + Math.sin(angle * orb.speed * 50) * orb.r;

        ctx.beginPath();
        ctx.arc(satX, satY, 5, 0, Math.PI * 2);
        ctx.fillStyle = orb.color;
        ctx.fill();

        // Label on Canvas (Non-DOM text to force vision testing)
        ctx.fillStyle = orb.color;
        ctx.font = '11px Segoe UI';
        ctx.fillText(orb.name, satX + 8, satY + 3);
      });

      angle += 0.01;
      requestAnimationFrame(renderOrbit);
    }

    renderOrbit();
  }

  console.log('[ISRO Dashboard] Initialized in offline mode.');
});
