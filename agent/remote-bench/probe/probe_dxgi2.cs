// DXGI Desktop Duplication latency probe — uses SharpDX (the standard .NET DXGI
// wrapper) so the COM interop is correct. Measures on adapter0/output0:
//   A) AcquireNextFrame(0)   — non-blocking; WAIT_TIMEOUT when screen idle
//   B) AcquireNextFrame(500) — block up to 500ms for a new frame
//   C) full capture path     — Acquire + CopyResource + Map (= what node-screenshots does)
using System;
using System.Diagnostics;
using SharpDX;
using SharpDX.Direct3D11;
using SharpDX.DXGI;
using Device = SharpDX.Direct3D11.Device;
using MapFlags = SharpDX.Direct3D11.MapFlags;
using DXGIResource = SharpDX.DXGI.Resource;

internal static class Probe {
  static double Median(double[] xs) { Array.Sort(xs); return xs[xs.Length / 2]; }

  [STAThread]
  static void Main() {
    var factory = new Factory1();
    var adapter = factory.GetAdapter1(0);
    var device = new Device(adapter);
    var output = adapter.GetOutput(0);
    var output1 = output.QueryInterface<Output1>();
    var b = output.Description.DesktopBounds;
    int w = b.Right - b.Left;
    int h = b.Bottom - b.Top;
    var dup = output1.DuplicateOutput(device);
    Console.WriteLine("output0: " + w + "x" + h + "  (" + (w * h * 4 / 1048576.0).ToString("0.0") + "MB raw)");

    var tdesc = new Texture2DDescription {
      CpuAccessFlags = CpuAccessFlags.Read, BindFlags = BindFlags.None,
      Format = Format.B8G8R8A8_UNorm, Width = w, Height = h,
      OptionFlags = ResourceOptionFlags.None, MipLevels = 1, ArraySize = 1,
      SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Staging
    };
    var staging = new Texture2D(device, tdesc);

    // warm
    try { OutputDuplicateFrameInformation fi0; DXGIResource r0; dup.AcquireNextFrame(1000, out fi0, out r0); r0.Dispose(); dup.ReleaseFrame(); }
    catch (SharpDXException) { }

    // Phase A: timeout=0
    {
      var times = new double[30]; int timeouts = 0, present = 0;
      for (int i = 0; i < 30; i++) {
        var t = Stopwatch.StartNew();
        try {
          OutputDuplicateFrameInformation fi; DXGIResource res; dup.AcquireNextFrame(0, out fi, out res);
          t.Stop();
          times[i] = t.Elapsed.TotalMilliseconds;
          if (fi.LastPresentTime != 0L) present++;
          res.Dispose(); dup.ReleaseFrame();
        } catch (SharpDXException ex) {
          t.Stop(); times[i] = t.Elapsed.TotalMilliseconds;
          const uint WAIT_TIMEOUT = 0x887A0028;
          if ((uint)ex.ResultCode.Code == WAIT_TIMEOUT) timeouts++;
        }
        System.Threading.Thread.Sleep(16);
      }
      Console.WriteLine("\nA) AcquireNextFrame(0) ×30");
      Console.WriteLine("   median=" + Median(times).ToString("0.000") + "ms  min=" + Min(times).ToString("0.000") + "  max=" + Max(times).ToString("0.000"));
      Console.WriteLine("   WAIT_TIMEOUT (no change): " + timeouts + "/30   frames w/ new content: " + present + "/30");
    }

    // Phase C: full capture (Acquire + CopyResource + Map) — the node-screenshots equivalent
    {
      var times = new double[10]; int got = 0;
      for (int i = 0; i < 10; i++) {
        var t = Stopwatch.StartNew();
        OutputDuplicateFrameInformation fi = default(OutputDuplicateFrameInformation); DXGIResource res = null;
        // retry: AcquireNextFrame(0) can transiently return WAIT_TIMEOUT right after a release
        for (int attempt = 0; attempt < 10; attempt++) {
          try { dup.AcquireNextFrame(50, out fi, out res); break; }
          catch (SharpDXException) { System.Threading.Thread.Sleep(5); }
        }
        if (res == null) continue;
        using (var tex = res.QueryInterface<Texture2D>()) {
          device.ImmediateContext.CopyResource(tex, staging);
          var box = device.ImmediateContext.MapSubresource(staging, 0, MapMode.Read, MapFlags.None);
          unsafe { byte firstByte = ((byte*)box.DataPointer.ToPointer())[0]; }
          device.ImmediateContext.UnmapSubresource(staging, 0);
        }
        t.Stop(); times[got++] = t.Elapsed.TotalMilliseconds;
        res.Dispose(); dup.ReleaseFrame();
        System.Threading.Thread.Sleep(16);
      }
      Array.Resize(ref times, got);
      Console.WriteLine("\nC) full capture (Acquire+CopyResource+Map) ×10");
      Console.WriteLine("   median=" + Median(times).ToString("0.000") + "ms  min=" + Min(times).ToString("0.000") + "  max=" + Max(times).ToString("0.000"));
      Console.WriteLine("   (node-screenshots captureImage measures ~130ms — compare)");
    }

    // Phase B: timeout=500 (block until new frame / timeout)
    {
      var times = new double[10]; int present = 0;
      for (int i = 0; i < 10; i++) {
        var t = Stopwatch.StartNew();
        try {
          OutputDuplicateFrameInformation fi; DXGIResource res; dup.AcquireNextFrame(500, out fi, out res);
          t.Stop(); times[i] = t.Elapsed.TotalMilliseconds;
          if (fi.LastPresentTime != 0L) present++;
          res.Dispose(); dup.ReleaseFrame();
        } catch (SharpDXException) { t.Stop(); times[i] = t.Elapsed.TotalMilliseconds; }
      }
      Console.WriteLine("\nB) AcquireNextFrame(500) ×10");
      Console.WriteLine("   median=" + Median(times).ToString("0.000") + "ms  min=" + Min(times).ToString("0.000") + "  max=" + Max(times).ToString("0.000"));
      Console.WriteLine("   frames w/ new content: " + present + "/10");
    }

    staging.Dispose(); dup.Dispose(); output1.Dispose(); output.Dispose();
    device.Dispose(); adapter.Dispose(); factory.Dispose();
  }

  static double Min(double[] xs) { double m = double.MaxValue; for (int i = 0; i < xs.Length; i++) if (xs[i] < m) m = xs[i]; return m; }
  static double Max(double[] xs) { double m = 0; for (int i = 0; i < xs.Length; i++) if (xs[i] > m) m = xs[i]; return m; }
}
