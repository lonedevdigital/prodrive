<script lang="ts">
  export let name:
    | "brand"
    | "search"
    | "folder"
    | "file"
    | "plus"
    | "upload"
    | "uploadFolder"
    | "refresh"
    | "paste"
    | "open"
    | "rename"
    | "copy"
    | "cut"
    | "share"
    | "link"
    | "delete"
    | "logout"
    | "home"
    | "download"
    | "grid"
    | "list" = "file";
  export let size = 16;
</script>

<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "brand"}
    <path d="M12 3 3 8.2 12 21l9-12.8L12 3Z"></path>
    <path d="M7.5 8.2h9"></path>
  {:else if name === "search"}
    <circle cx="11" cy="11" r="7"></circle>
    <path d="m20 20-3.5-3.5"></path>
  {:else if name === "folder"}
    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"></path>
  {:else if name === "file"}
    <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-6Z"></path>
    <path d="M14 2v6h5"></path>
  {:else if name === "plus"}
    <path d="M12 5v14"></path>
    <path d="M5 12h14"></path>
  {:else if name === "upload"}
    <path d="M12 16V6"></path>
    <path d="m8 10 4-4 4 4"></path>
    <path d="M4 19h16"></path>
  {:else if name === "uploadFolder"}
    <path d="M3 8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z"></path>
    <path d="M12 15V10"></path>
    <path d="m10 12 2-2 2 2"></path>
  {:else if name === "refresh"}
    <path d="M20 11a8 8 0 1 0 2.1 5.4"></path>
    <path d="M20 4v7h-7"></path>
  {:else if name === "paste"}
    <rect x="8" y="4" width="8" height="4" rx="1"></rect>
    <path d="M7 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6"></path>
    <path d="M13 12h7"></path>
    <path d="M17 8v8"></path>
  {:else if name === "open"}
    <path d="M14 3h7v7"></path>
    <path d="m10 14 11-11"></path>
    <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path>
  {:else if name === "rename"}
    <path d="m4 20 4-1 10-10-3-3L5 16l-1 4Z"></path>
    <path d="m13 6 3 3"></path>
  {:else if name === "copy"}
    <rect x="9" y="9" width="11" height="11" rx="2"></rect>
    <rect x="4" y="4" width="11" height="11" rx="2"></rect>
  {:else if name === "cut"}
    <circle cx="6" cy="18" r="2"></circle>
    <circle cx="18" cy="18" r="2"></circle>
    <path d="M8 16 16 8"></path>
    <path d="m8 8 8 8"></path>
  {:else if name === "share"}
    <circle cx="18" cy="5" r="3"></circle>
    <circle cx="6" cy="12" r="3"></circle>
    <circle cx="18" cy="19" r="3"></circle>
    <path d="m8.7 10.8 6.6-3.6"></path>
    <path d="m8.7 13.2 6.6 3.6"></path>
  {:else if name === "link"}
    <path d="M10 13a5 5 0 0 0 7.1 0l2.8-2.8a5 5 0 1 0-7.1-7.1L11 4.9"></path>
    <path d="M14 11a5 5 0 0 0-7.1 0L4.1 13.8a5 5 0 1 0 7.1 7.1L13 19.1"></path>
  {:else if name === "delete"}
    <path d="M3 6h18"></path>
    <path d="M8 6V4h8v2"></path>
    <path d="M6 6l1 14h10l1-14"></path>
  {:else if name === "logout"}
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
    <path d="m10 17 5-5-5-5"></path>
    <path d="M15 12H3"></path>
  {:else if name === "home"}
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
    <polyline points="9 22 9 12 15 12 15 22"></polyline>
  {:else if name === "download"}
    <path d="M12 15V3"></path>
    <path d="m8 11 4 4 4-4"></path>
    <path d="M4 19h16"></path>
  {:else if name === "grid"}
    <rect x="3" y="3" width="7" height="7" rx="1"></rect>
    <rect x="14" y="3" width="7" height="7" rx="1"></rect>
    <rect x="3" y="14" width="7" height="7" rx="1"></rect>
    <rect x="14" y="14" width="7" height="7" rx="1"></rect>
  {:else if name === "list"}
    <line x1="8" y1="6" x2="21" y2="6"></line>
    <line x1="8" y1="12" x2="21" y2="12"></line>
    <line x1="8" y1="18" x2="21" y2="18"></line>
    <circle cx="3.5" cy="6" r="0.8" fill="currentColor" stroke="none"></circle>
    <circle cx="3.5" cy="12" r="0.8" fill="currentColor" stroke="none"></circle>
    <circle cx="3.5" cy="18" r="0.8" fill="currentColor" stroke="none"></circle>
  {/if}
</svg>
