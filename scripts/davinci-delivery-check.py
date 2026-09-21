"""Offline behavior checks; never imports the Resolve module."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location("delivery", Path(__file__).with_name("davinci-delivery.py"))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

class API:
    def __init__(self, request):
        self.request=request; self.settings={}; self.events=[]; self.current=None
        self.fail=None; self.offset=0; self.source_offset=0; self.path=request['assembly']['sources'][0]['path']
    def GetProjectManager(self): return self
    def GetCurrentProject(self): return self.current
    def GetName(self): return self.request['projectName']
    def CreateProject(self, name):
        self.events.append('create')
        if self.fail=='collision': return None
        self.current=self
        return self
    def LoadProject(self,name): self.events.append('load'); self.current=self; return self
    def SetSetting(self,k,v): self.settings[k]=v; return True
    def GetSetting(self,k): return self.settings[k]
    def GetMediaPool(self): return self
    def GetRootFolder(self): return self
    def AddSubFolder(self,parent,name): return self
    def MoveClips(self,clips,folder): return True
    def ImportTimelineFromFile(self,path):
        self.events.append('import'); return None if self.fail=='import' else self
    def GetStartFrame(self): return 86400
    def GetTrackCount(self,kind): return 1 if kind=='video' else 0
    def GetItemListInTrack(self,kind,index): return [self]
    def GetStart(self,*args): return 86400+self.offset
    def GetDuration(self,*args): return 24
    def GetSourceStartFrame(self): return self.source_offset
    def GetMediaPoolItem(self): return self
    def GetClipProperty(self,key): return self.path
    def AddMarker(self,*args): return self.fail!='marker'
    def SetCurrentTimeline(self,t): return True
    def SaveProject(self): self.events.append('save'); return self.fail!='save'
    def OpenPage(self,page): return True
    def ExportProject(self,name,path):
        if self.fail=='export': return False
        Path(path).write_bytes(b'drp'); return True
    def DeleteProject(self,*args): raise AssertionError('must never delete')

class Checks(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        media=Path(self.tmp.name)/'a.mp4'; media.write_bytes(b'media')
        otio=Path(self.tmp.name)/'timeline.otio'; otio.write_text('{}')
        self.r={'operationId':'test','projectId':'p','revision':1,'projectName':'P-r1-test','otioPath':str(otio),'assembly':{'fps':{'num':24000,'den':1001},'width':320,'height':240,'sources':[{'id':'a','path':str(media),'fps':{'num':24000,'den':1001}}],'tracks':[{'kind':'Video','name':'V1','clips':[{'sourceId':'a','sourceStartSeconds':0,'startFrame':0,'durationFrames':24}]}]},'handoff':[{'id':'n','sceneId':'s','description':'Title','destination':'Resolve','startFrame':0,'durationFrames':24}]}
        self.api=API(self.r)
    def test_delivery(self):
        events=[]; self.r['drpPath']=str(Path(self.tmp.name)/'project.drp')
        result=d.deliver(self.r,self.api,events.append)
        self.assertTrue(result['verified']); self.assertEqual(self.api.events,['create','import','save'])
        self.assertLess([e['stage'] for e in events].index('created'),[e['stage'] for e in events].index('imported'))
    def test_errors(self):
        for failure in ['collision','import','marker','save','export']:
            with self.subTest(failure=failure):
                api=API(self.r); api.fail=failure
                self.r['drpPath']=str(Path(self.tmp.name)/'out.drp')
                with self.assertRaises(Exception): d.deliver(self.r,api,lambda e:None)
    def test_protect_current(self):
        self.api.current=object()
        with self.assertRaisesRegex(Exception,'feche'): d.deliver(self.r,self.api,lambda e:None)
        self.assertEqual(self.api.events,[])
    def test_positions_and_media(self):
        for attr,value in [('offset',1),('source_offset',2),('path','/missing')]:
            with self.subTest(attr=attr):
                api=API(self.r); setattr(api,attr,value)
                with self.assertRaises(Exception): d.deliver(self.r,api,lambda e:None)
                self.assertNotIn('save',api.events)
    def test_reopen_does_not_import_or_save(self):
        self.r['mode']='open'
        result=d.deliver(self.r,self.api,lambda e:None)
        self.assertTrue(result['ok']);self.assertEqual(self.api.events,['load'])
if __name__=='__main__': unittest.main()
