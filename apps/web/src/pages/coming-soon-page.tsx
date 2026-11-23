import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Rocket, Activity, History, Settings, ArrowLeft, Clock } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';

interface ComingSoonProps {
  title: string;
  description: string;
  phase: string;
  phaseNumber: number;
  icon: 'deployments' | 'observability' | 'activity' | 'settings';
}

export function ComingSoonPage({ title, description, phase, phaseNumber, icon }: ComingSoonProps) {
  const navigate = useNavigate();

  const getIcon = () => {
    switch (icon) {
      case 'deployments':
        return <Rocket className="h-8 w-8 text-indigo-400" />;
      case 'observability':
        return <Activity className="h-8 w-8 text-blue-400" />;
      case 'activity':
        return <History className="h-8 w-8 text-purple-400" />;
      case 'settings':
        return <Settings className="h-8 w-8 text-amber-400" />;
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-12 space-y-6">
      <Card className="border-slate-800 bg-slate-900/80 text-center p-8 shadow-2xl">
        <CardHeader className="space-y-4">
          <div className="mx-auto h-16 w-16 rounded-2xl bg-slate-800/80 border border-slate-700 flex items-center justify-center">
            {getIcon()}
          </div>
          <div>
            <Badge variant="outline" className="mb-2 text-indigo-400 border-indigo-500/30">
              <Clock className="h-3 w-3 mr-1 inline" /> Coming in Phase {phaseNumber}
            </Badge>
            <CardTitle className="text-2xl text-white">{title}</CardTitle>
          </div>
          <CardDescription className="text-slate-400 max-w-md mx-auto">
            {description}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="p-4 rounded-lg bg-slate-950/60 border border-slate-800/80 text-left max-w-md mx-auto">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
              Planned Deliverable: Phase {phaseNumber}
            </span>
            <p className="text-xs text-slate-300 font-mono">{phase}</p>
          </div>
          <Button variant="outline" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Go Back
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
