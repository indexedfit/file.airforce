import { useEffect } from "react";

export default function App() {
  useEffect(() => {
    document.body.className = "bg-gray-50 text-gray-900";
  }, []);

  return (
    <>
      <header className="bg-white sticky top-0 z-20 border-b">
        <div className="container mx-auto px-4 py-3 flex items-center gap-3">
          <a href="/" data-link className="font-bold text-xl">
            file.airforce
          </a>
          <div className="ml-auto text-sm flex items-center gap-3">
            <div className="flex items-baseline gap-1">
              <span id="conn-count" className="font-semibold">
                0
              </span>
              <span className="text-xs text-gray-500">peers</span>
            </div>
            <button id="peer-info-toggle" className="px-2 py-1 border rounded text-xs">
              Details
            </button>
          </div>
        </div>
        <div id="peer-info-panel" className="hidden border-t">
          <div className="container mx-auto px-4 py-3">
            <div className="grid md:grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-gray-500">Peer ID</div>
                <div id="peer-id" className="font-mono text-xs break-all select-all">
                  —
                </div>
              </div>
              <div className="md:col-span-2">
                <div className="text-xs text-gray-500">Addresses</div>
                <ul id="addr-list" className="text-xs space-y-1 max-h-24 overflow-auto"></ul>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 snap-scroll">
        <section id="view-home">
          <div className="bg-white border rounded p-4">
            <h2 className="font-semibold mb-3">Create a drop</h2>
            <form id="upload-form" className="space-y-3">
              <div
                id="dropzone"
                className="border-2 border-dashed rounded p-6 text-center text-sm text-gray-500 bg-gray-50 hover:bg-white"
              >
                <input id="file-input" type="file" multiple className="hidden" />
                <p>
                  Drag & drop files here, or{" "}
                  <button type="button" id="btn-browse" className="underline">
                    browse
                  </button>
                </p>
              </div>
              <div id="selected-files-panel" className="hidden">
                <div className="mt-2 text-sm font-medium">Selected files</div>
                <ul id="selected-file-list" className="mt-1 text-sm divide-y"></ul>
              </div>

              <div id="upload-progress" className="hidden">
                <div className="text-sm text-gray-700">
                  Adding files… <span id="progress-text"></span>
                </div>
                <div className="w-full bg-gray-200 h-2 rounded">
                  <div id="progress-bar" className="bg-blue-500 h-2 rounded" style={{ width: "0%" }}></div>
                </div>
              </div>

              <div id="create-room-panel" className="hidden">
                <hr className="my-3" />
                <div className="flex items-center gap-2">
                  <label className="text-sm" htmlFor="room-name">
                    Room name
                  </label>
                  <input
                    id="room-name"
                    type="text"
                    placeholder="Optional"
                    className="border rounded px-3 py-2 flex-1"
                  />
                  <button
                    id="btn-invite"
                    type="button"
                    className="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                    title="Generate invite link / QR"
                  >
                    Invite
                  </button>
                </div>
                <div id="invite-output" className="mt-3 hidden">
                  <div className="text-sm text-gray-600">Share this link:</div>
                  <div className="flex items-center gap-2">
                    <input
                      id="invite-link"
                      className="flex-1 border rounded px-2 py-1 text-xs"
                      readOnly
                    />
                    <button id="btn-copy-invite" type="button" className="px-2 py-1 border rounded">
                      Copy
                    </button>
                  </div>
                  <canvas id="invite-qr" className="mt-3 w-40 h-40 border rounded"></canvas>
                </div>
              </div>
            </form>
          </div>

          <div className="mt-6 bg-white border rounded p-4">
            <h3 className="font-semibold">Recent drops</h3>
            <ul id="drops-list" className="mt-2 divide-y"></ul>
          </div>
        </section>

        <section id="view-drops" hidden>
          <div className="bg-white border rounded p-4">
            <h2 className="font-semibold">All drops</h2>
            <ul id="drops-list-full" className="mt-2 divide-y"></ul>
          </div>
        </section>

        <section id="view-rooms" hidden>
          <div className="bg-white border rounded p-4">
            <h2 className="font-semibold">Rooms</h2>
            <div id="rooms-info" className="text-sm text-gray-600"></div>
            <ul id="rooms-list" className="mt-2 divide-y"></ul>
          </div>
        </section>

        <section id="view-peers" hidden>
          <div className="bg-white border rounded p-4">
            <h2 className="font-semibold">Peers</h2>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <h3 className="font-semibold mb-2 text-sm text-gray-700">Connections by type</h3>
                <ul id="peer-types" className="text-sm space-y-1"></ul>
              </div>
              <div>
                <h3 className="font-semibold mb-2 text-sm text-gray-700">Known peers</h3>
                <ul id="peer-details" className="text-sm space-y-2"></ul>
              </div>
            </div>
          </div>
        </section>
      </main>

      <div
        id="toast"
        className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-black text-white text-sm px-3 py-2 rounded hidden"
      ></div>
    </>
  );
}
