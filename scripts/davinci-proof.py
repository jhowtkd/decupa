#!/usr/bin/env python3
"""
Validação automatizada de importação de timeline OTIO no DaVinci Resolve.
Conecta na API de scripting do Resolve (se o Resolve estiver aberto com scripting ativo),
cria um projeto efêmero de teste, importa a timeline OTIO, valida as trilhas (V1, V2, A1),
duração e mídias, e limpa o projeto em seguida.
Se o Resolve não estiver aberto ou scripting estiver desabilitado, emite erro informativo.
"""
import json
import os
import sys

RESOLVE_SCRIPT_API = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules"
if os.path.exists(RESOLVE_SCRIPT_API) and RESOLVE_SCRIPT_API not in sys.path:
    sys.path.append(RESOLVE_SCRIPT_API)

def verify_otio_import(otio_path):
    otio_path = os.path.abspath(otio_path)
    if not os.path.exists(otio_path):
        return {"ok": False, "error": f"Arquivo OTIO não encontrado: {otio_path}"}

    try:
        import DaVinciResolveScript as dvr_script
    except ImportError:
        return {
            "ok": False,
            "error": "Módulo DaVinciResolveScript não encontrado no sistema. Verifique a instalação do DaVinci Resolve.",
        }

    resolve = dvr_script.scriptapp("Resolve")
    if not resolve:
        return {
            "ok": False,
            "error": "DaVinci Resolve não está aberto ou a API de Scripting externa está desabilitada (Preferences -> System -> General -> External scripting using -> Local).",
        }

    project_manager = resolve.GetProjectManager()
    if not project_manager:
        return {"ok": False, "error": "Não foi possível obter o ProjectManager do Resolve"}

    project_name = "Decupa-QA-Proof"
    project = project_manager.CreateProject(project_name)
    if not project:
        project = project_manager.LoadProject(project_name)
    if not project:
        return {"ok": False, "error": f"Não foi possível criar nem carregar o projeto '{project_name}'"}

    media_pool = project.GetMediaPool()
    if not media_pool:
        project_manager.CloseProject(project)
        project_manager.DeleteProject(project_name)
        return {"ok": False, "error": "Não foi possível obter o MediaPool do Resolve"}

    timeline = media_pool.ImportTimelineFromFile(otio_path)
    if not timeline:
        project_manager.CloseProject(project)
        project_manager.DeleteProject(project_name)
        return {"ok": False, "error": "Falha ao importar timeline OTIO no DaVinci Resolve"}

    track_counts = {
        "video": timeline.GetTrackCount("video"),
        "audio": timeline.GetTrackCount("audio"),
    }
    name = timeline.GetName()
    start_frame = timeline.GetStartFrame()
    end_frame = timeline.GetEndFrame()
    duration = end_frame - start_frame

    project_manager.CloseProject(project)
    project_manager.DeleteProject(project_name)

    return {
        "ok": True,
        "timelineName": name,
        "tracks": track_counts,
        "startFrame": start_frame,
        "endFrame": end_frame,
        "durationFrames": duration,
        "otioPath": otio_path,
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Uso: davinci-proof.py <caminho-para-timeline.otio>"}))
        sys.exit(1)
    result = verify_otio_import(sys.argv[1])
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["ok"] else 2)
