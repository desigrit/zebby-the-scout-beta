; Remove only the catalog's model artifacts. Never recursively delete app data.
!macro deleteTrackerModels folder
  Delete "${folder}\SmolLM2-360M-Instruct-Q4_K_M.gguf"
  Delete "${folder}\SmolLM2-360M-Instruct-Q4_K_M.gguf.part"
  Delete "${folder}\SmolLM2-360M-Instruct-Q4_K_M.gguf.verified.json"
  Delete "${folder}\LFM2.5-350M-Q4_K_M.gguf"
  Delete "${folder}\LFM2.5-350M-Q4_K_M.gguf.part"
  Delete "${folder}\LFM2.5-350M-Q4_K_M.gguf.verified.json"
  Delete "${folder}\lfm25-350m-LICENSE.txt"
  Delete "${folder}\gemma-3-270m-it-qat-Q4_0.gguf"
  Delete "${folder}\gemma-3-270m-it-qat-Q4_0.gguf.part"
  Delete "${folder}\gemma-3-270m-it-qat-Q4_0.gguf.verified.json"
  Delete "${folder}\gemma3-270m-LICENSE.txt"
  Delete "${folder}\gemma3-270m-USE-POLICY.txt"
  Delete "${folder}\gemma3-270m-NOTICE.txt"
  Delete "${folder}\Qwen3-0.6B-Q8_0.gguf"
  Delete "${folder}\Qwen3-0.6B-Q8_0.gguf.part"
  Delete "${folder}\Qwen3-0.6B-Q8_0.gguf.verified.json"
  Delete "${folder}\Qwen3-4B-Q4_K_M.gguf"
  Delete "${folder}\Qwen3-4B-Q4_K_M.gguf.part"
  Delete "${folder}\Qwen3-4B-Q4_K_M.gguf.verified.json"
  Delete "${folder}\Qwen3-8B-Q4_K_M.gguf"
  Delete "${folder}\Qwen3-8B-Q4_K_M.gguf.part"
  Delete "${folder}\Qwen3-8B-Q4_K_M.gguf.verified.json"
  RMDir "${folder}"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro deleteTrackerModels "$LOCALAPPDATA\Zebby Core\Models"
    !insertmacro deleteTrackerModels "$APPDATA\Zebby Core\Models"
  ${endif}
!macroend
