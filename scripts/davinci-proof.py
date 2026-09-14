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

# Variável de ambiente (testes) apontando para um módulo stub do Resolve
# (arquivo .py ou diretório contendo DaVinciResolveScript.py). Quando ausente,
# o comportamento padrão (API real) é mantido.
RESOLVE_STUB_ENV = "DECUPA_RESOLVE_STUB"

TRACK_TYPES = ("video", "audio")


def _load_resolve_module():
    """Carrega o módulo DaVinciResolveScript (ou o stub de teste).

    Retorna (módulo, None) em caso de sucesso ou (None, mensagem de erro).
    """
    stub = os.environ.get(RESOLVE_STUB_ENV)
    if stub:
        if os.path.isdir(stub):
            if stub not in sys.path:
                sys.path.insert(0, stub)
        elif os.path.isfile(stub):
            import importlib.util

            spec = importlib.util.spec_from_file_location("DaVinciResolveScript", stub)
            if spec is None or spec.loader is None:
                return None, f"Stub do Resolve inválido: {stub}"
            module = importlib.util.module_from_spec(spec)
            sys.modules["DaVinciResolveScript"] = module
            try:
                spec.loader.exec_module(module)
            except Exception as exc:
                return None, f"Falha ao carregar stub do Resolve ({stub}): {exc}"
            return module, None
        else:
            return None, f"Stub do Resolve não encontrado: {stub}"

    try:
        import DaVinciResolveScript as dvr_script
    except ImportError:
        return (
            None,
            "Módulo DaVinciResolveScript não encontrado no sistema. Verifique a instalação do DaVinci Resolve.",
        )
    return dvr_script, None


def _expected_clips_per_track(otio_path):
    """Conta os clipes esperados por trilha a partir do OTIO (JSON).

    Retorna ({"video": [...], "audio": [...]}, None) ou (None, erro).
    """
    try:
        with open(otio_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        return None, f"Não foi possível ler o OTIO como JSON: {exc}"
    try:
        tracks_node = data.get("tracks", {})
        children = tracks_node.get("children", [])
        expected = {"video": [], "audio": []}
        for track in children:
            if not isinstance(track, dict) or track.get("OTIO_SCHEMA") != "Track.1":
                continue
            kind = str(track.get("kind", "")).lower()
            if kind not in expected:
                continue
            count = sum(
                1
                for child in track.get("children", [])
                if isinstance(child, dict) and child.get("OTIO_SCHEMA") == "Clip.1"
            )
            expected[kind].append(count)
    except (AttributeError, TypeError) as exc:
        return None, f"Estrutura OTIO inesperada: {exc}"
    return expected, None


def _item_name(item, position):
    try:
        if hasattr(item, "GetName"):
            name = item.GetName()
            if name:
                return str(name)
    except Exception:
        pass
    return f"item {position}"


def _validate_timeline_items(timeline, expected):
    """Enumera os itens importados e checa mídia online.

    Retorna (actual, offline, None) ou (None, None, erro de API).
    """
    if not hasattr(timeline, "GetItemListInTrack"):
        return (
            None,
            None,
            "API do Resolve instalada não suporta GetItemListInTrack; "
            "não foi possível validar os clipes importados.",
        )
    actual = {"video": [], "audio": []}
    offline = []
    for track_type in TRACK_TYPES:
        for index in range(1, len(expected[track_type]) + 1):
            try:
                items = timeline.GetItemListInTrack(track_type, index)
            except Exception as exc:
                return (
                    None,
                    None,
                    f"Falha ao enumerar itens ({track_type} trilha {index}): {exc}",
                )
            items = list(items or [])
            actual[track_type].append(len(items))
            for position, item in enumerate(items, start=1):
                local = f"{track_type} trilha {index} item {position} ({_item_name(item, position)})"
                if not hasattr(item, "GetMediaPoolItem"):
                    return (
                        None,
                        None,
                        f"API do Resolve instalada não suporta GetMediaPoolItem; "
                        f"não foi possível validar a mídia de {local}.",
                    )
                try:
                    pool_item = item.GetMediaPoolItem()
                except Exception as exc:
                    return None, None, f"Falha ao ler mídia de {local}: {exc}"
                if pool_item is None:
                    offline.append(f"{local}: mídia offline (sem MediaPoolItem)")
                    continue
                if hasattr(pool_item, "GetClipProperty"):
                    try:
                        file_path = pool_item.GetClipProperty("File Path")
                    except Exception:
                        file_path = None
                    if file_path and not os.path.exists(file_path):
                        offline.append(f"{local}: mídia offline (arquivo ausente: {file_path})")
    return actual, offline, None


def _close_and_delete_project(project_manager, project, project_name):
    try:
        project_manager.CloseProject(project)
    except Exception:
        pass
    try:
        project_manager.DeleteProject(project_name)
    except Exception:
        pass


def verify_otio_import(otio_path):
    otio_path = os.path.abspath(otio_path)
    if not os.path.exists(otio_path):
        return {"ok": False, "error": f"Arquivo OTIO não encontrado: {otio_path}"}

    dvr_script, load_error = _load_resolve_module()
    if dvr_script is None:
        return {"ok": False, "error": load_error}

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

    try:
        result = _validate_imported_timeline(timeline, otio_path)
    except Exception as exc:
        result = {"ok": False, "error": f"Falha inesperada na validação da timeline: {exc}"}
    finally:
        # Limpeza do projeto efêmero em TODOS os caminhos (sucesso ou falha).
        _close_and_delete_project(project_manager, project, project_name)
    return result


def _safe_timeline_call(timeline, method, *args):
    try:
        func = getattr(timeline, method, None)
    except Exception:
        func = None
    if not callable(func):
        return None, (
            f"API do Resolve instalada não suporta {method}; "
            "não foi possível validar a timeline importada."
        )
    try:
        return func(*args), None
    except Exception as exc:
        return None, f"Falha ao chamar {method}{list(args) or ''}: {exc}"


def _validate_imported_timeline(timeline, otio_path):
    base = {"otioPath": otio_path}

    video_tracks, error = _safe_timeline_call(timeline, "GetTrackCount", "video")
    if error is not None:
        return {"ok": False, "error": error, **base}
    audio_tracks, error = _safe_timeline_call(timeline, "GetTrackCount", "audio")
    if error is not None:
        return {"ok": False, "error": error, **base}
    track_counts = {"video": video_tracks, "audio": audio_tracks}

    name, error = _safe_timeline_call(timeline, "GetName")
    if error is not None:
        return {"ok": False, "error": error, **base}
    start_frame, error = _safe_timeline_call(timeline, "GetStartFrame")
    if error is not None:
        return {"ok": False, "error": error, **base}
    end_frame, error = _safe_timeline_call(timeline, "GetEndFrame")
    if error is not None:
        return {"ok": False, "error": error, **base}

    expected, error = _expected_clips_per_track(otio_path)
    if error is not None:
        return {"ok": False, "error": error, **base}

    actual, offline, error = _validate_timeline_items(timeline, expected)
    if error is not None:
        return {
            "ok": False,
            "error": error,
            "expectedClips": expected,
            **base,
        }

    divergencias = []
    for track_type in TRACK_TYPES:
        if len(expected[track_type]) != track_counts[track_type]:
            divergencias.append(
                f"trilhas {track_type}: esperado {len(expected[track_type])}, "
                f"importado {track_counts[track_type]}"
            )
        for index, (want, got) in enumerate(zip(expected[track_type], actual[track_type]), start=1):
            if want != got:
                divergencias.append(
                    f"{track_type} trilha {index}: esperados {want} clipe(s), "
                    f"importados {got}"
                )
    divergencias.extend(f"mídia offline: {entry}" for entry in offline)

    report = {
        "timelineName": name,
        "tracks": track_counts,
        "startFrame": start_frame,
        "endFrame": end_frame,
        "durationFrames": end_frame - start_frame,
        "expectedClips": expected,
        "actualClips": actual,
        "offline": offline,
        **base,
    }
    if divergencias:
        report["ok"] = False
        report["error"] = "Divergências na timeline importada: " + "; ".join(divergencias)
    else:
        report["ok"] = True
    return report

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Uso: davinci-proof.py <caminho-para-timeline.otio>"}))
        sys.exit(1)
    result = verify_otio_import(sys.argv[1])
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["ok"] else 2)
