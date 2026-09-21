"""Permanent Resolve delivery. Never deletes projects or saves unrelated work."""
import argparse
import fcntl
import tempfile
import json
import math
import os
from pathlib import Path
import sys


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def validate(request):
    require(isinstance(request, dict), 'pedido inválido')
    for key in ('operationId', 'projectId', 'projectName'):
        require(isinstance(request.get(key), str) and bool(request[key].strip()), f'{key} inválido')
    require(isinstance(request.get('revision'), int) and request['revision'] >= 0, 'revisão inválida')
    assembly = request['assembly']
    rate = assembly['fps']['num'] / assembly['fps']['den']
    require(math.isfinite(rate) and rate > 0, 'FPS inválido')
    require(assembly['width'] > 0 and assembly['height'] > 0, 'resolução inválida')
    require(Path(request['otioPath']).is_file(), 'timeline ausente')
    require(request.get('mode', 'create') in ('create', 'open', 'export'), 'modo inválido')
    if request.get('drpPath'):
        require(Path(request['drpPath']).is_absolute() and not Path(request['drpPath']).exists(), 'destino DRP existe ou é inválido')
    return assembly


def verify(timeline, assembly):
    rate = assembly['fps']['num'] / assembly['fps']['den']
    actual_rate = float(timeline.GetSetting('timelineFrameRate'))
    require(abs(actual_rate - rate) < .002, 'FPS importado difere da montagem')
    for key, expected in [('timelineResolutionWidth', assembly['width']), ('timelineResolutionHeight', assembly['height'])]:
        require(int(timeline.GetSetting(key)) == expected, 'resolução importada difere da montagem')
    sources = {s['id']: s for s in assembly['sources']}
    media = []
    for kind in ('video', 'audio'):
        tracks = [t for t in assembly['tracks'] if t['kind'].lower() == kind]
        require(timeline.GetTrackCount(kind) == len(tracks), f'quantidade de faixas {kind} diferente')
        for index, track in enumerate(tracks, 1):
            items = sorted(timeline.GetItemListInTrack(kind, index) or [], key=lambda i: i.GetStart(True))
            clips = sorted(track['clips'], key=lambda c: c['startFrame'])
            require(len(items) == len(clips), 'quantidade de clipes diferente')
            for item, clip in zip(items, clips):
                source = sources[clip['sourceId']]
                pool = item.GetMediaPoolItem()
                require(pool is not None, 'mídia offline')
                path = pool.GetClipProperty('File Path')
                require(isinstance(path, str) and Path(path).is_file() and os.path.realpath(path) == os.path.realpath(source['path']), 'mídia ausente ou diferente')
                require(abs(item.GetStart(True) - timeline.GetStartFrame() - clip['startFrame']) < .01, 'posição de corte diferente')
                require(abs(item.GetDuration(True) - clip['durationFrames']) < .01, 'duração de clipe diferente')
                source_rate = source.get('fps') or assembly['fps']
                expected = clip['sourceStartSeconds'] * source_rate['num'] / source_rate['den']
                require(abs(item.GetSourceStartFrame() - expected) <= .51, 'intervalo de origem diferente')
                # Source out is inclusive; compare both boundaries at the media rate.
                expected_end = expected + clip['durationFrames'] / rate * source_rate['num'] / source_rate['den'] - 1
                require(abs(item.GetSourceEndFrame() - expected_end) <= .51, 'fim do intervalo de origem diferente')
                media.append(pool)
    return media


def deliver(request, resolve, emit):
    assembly = validate(request)
    require(resolve is not None, 'Não foi possível conectar à API do DaVinci Resolve. Abra o Resolve Studio e confira Preferences > System > General > External scripting using: Local. O arquivo .drp só pode ser gerado depois que o Resolve criar e salvar o projeto. Se a edição instalada não oferecer essa API, importe a timeline no Resolve e use File > Export Project para salvar o .drp.')
    manager = resolve.GetProjectManager()
    require(manager is not None, 'ProjectManager indisponível')
    mode = request.get('mode', 'create')
    current = manager.GetCurrentProject()
    # Resolve exposes no reliable unsaved-change getter in the installed API.
    # Do not close or auto-save another user's project to make room.
    if current is not None:
        same = mode != 'create' and callable(getattr(current, 'GetName', None)) and current.GetName() == request['projectName']
        require(same, 'Salve e feche o projeto atual no Resolve antes de continuar.')
    name = request['projectName']
    if mode == 'create':
        project = manager.CreateProject(name)
        require(project is not None, 'nome de projeto indisponível; solicite outra cópia')
        project_id = project.GetUniqueId()
        require(bool(project_id), 'identidade do projeto indisponível')
        emit({'stage': 'created', 'projectName': name})
        rate = assembly['fps']['num'] / assembly['fps']['den']
        fps = {24000/1001: '23.976', 30000/1001: '29.97', 60000/1001: '59.94'}.get(rate, str(rate))
        for key, value in [('timelineFrameRate', fps), ('timelineResolutionWidth', str(assembly['width'])), ('timelineResolutionHeight', str(assembly['height']))]:
            require(project.SetSetting(key, value), f'falha ao configurar {key}')
        pool = project.GetMediaPool()
        timeline = pool.ImportTimelineFromFile(request['otioPath'])
        require(timeline is not None, 'falha ao importar timeline')
        emit({'stage': 'imported', 'projectName': name})
        media = verify(timeline, assembly)
        folder = pool.AddSubFolder(pool.GetRootFolder(), 'Mídias Decupa')
        require(folder is not None and pool.MoveClips(list(dict.fromkeys(media)), folder), 'falha ao organizar mídias')
        # Markers at the same frame are combined; Resolve permits one per frame.
        markers = {}
        for note in request.get('handoff', []):
            markers.setdefault(note['startFrame'], []).append(note)
        for frame, notes in markers.items():
            description = '\n'.join(f"{n['destination']}: {n['description']}" for n in notes)
            require(timeline.AddMarker(frame, 'Yellow', 'Animação pendente', description, max(n['durationFrames'] for n in notes), json.dumps([n['id'] for n in notes])), 'falha ao criar marcador')
        require(project.SetCurrentTimeline(timeline), 'falha ao abrir timeline')
        emit({'stage': 'verified', 'projectName': name})
        current = manager.GetCurrentProject()
        require(current is not None and callable(getattr(current, 'GetUniqueId', None)) and current.GetUniqueId() == project_id, 'projeto atual mudou; nada foi salvo')
        require(manager.SaveProject(), 'falha ao salvar projeto')
        emit({'stage': 'saved', 'projectName': name})
    else:
        project = current or manager.LoadProject(name)
        require(project is not None, 'projeto registrado não encontrado; solicite outra cópia')
    drp = request.get('drpPath')
    if drp:
        require(manager.ExportProject(name, drp), 'falha ao exportar DRP')
        require(Path(drp).is_file() and Path(drp).stat().st_size > 0, 'DRP não foi gravado')
        emit({'stage': 'exported', 'projectName': name})
    require(resolve.OpenPage('edit'), 'projeto salvo, mas não foi possível abrir a página Edit')
    return {'ok': True, 'projectName': name, 'verified': mode == 'create', **({'drpPath': drp} if drp else {})}


def connect():
    sys.path.append('/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules')
    try:
        import DaVinciResolveScript
        return DaVinciResolveScript.scriptapp('Resolve')
    except (ImportError, OSError) as exc:
        raise RuntimeError('API do Resolve indisponível; confira instalação/edição e scripting local.') from exc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    args = parser.parse_args()
    emit = lambda event: print(json.dumps(event, ensure_ascii=False), flush=True)
    try:
        request = json.loads(Path(args.request).read_text())
        validate(request)
        emit({'stage': 'connecting'})
        # The bridge may outlive a killed Node parent; keep an OS lock until it exits.
        with open(Path(tempfile.gettempdir()) / f'decupa-resolve-bridge-{os.getuid()}.lock', 'a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError('Outra ponte do Resolve ainda está em andamento.') from exc
            emit(deliver(request, connect(), emit))
        return 0
    except Exception as exc:
        emit({'ok': False, 'stage': 'error', 'error': str(exc)})
        return 1


if __name__ == '__main__':
    sys.exit(main())
